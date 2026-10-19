import { AutomationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

import { GitHubError } from "../GitHubApi.ts";
import type { WorkflowRunBody } from "./rest.ts";
import type { WorkflowRun } from "./types.ts";

export const failed = (message: string, cause?: unknown) =>
  new AutomationError({ message, ...(cause === undefined ? {} : { cause }) });

const SAFE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);
const isGitHubError = Schema.is(GitHubError);

export const knownRejection = (error: AutomationError) =>
  isGitHubError(error.cause) && SAFE_REJECTION_STATUSES.has(error.cause.status);

export const normalizeWorkflowFile = (value: string): string | null => {
  const prefix = ".github/workflows/";
  const name = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/iu.test(name)) return null;
  return prefix + name;
};

export const workflowName = (workflowFile: string) =>
  workflowFile.slice(".github/workflows/".length);

export const validCorrelationId = (value: string) =>
  value.length > 0 && value.length <= 256 && !containsControlCharacters(value);

export const containsControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

export const validSha = (value: string) => /^[A-Fa-f0-9]{40}$/u.test(value);
export const normalizedSha = (value: string) => value.toLowerCase();
export const validRunId = (value: string) =>
  /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value));

export const validateRepository = (value: string) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);

export const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

export const toWorkflowRun = (
  body: WorkflowRunBody,
  expected: {
    readonly workflowFile: string;
    readonly headSha: string;
    readonly correlationId?: string;
  },
): WorkflowRun | null => {
  const workflowPathMatches =
    body.path === expected.workflowFile ||
    (body.path.startsWith(expected.workflowFile + "@") &&
      body.path.length > expected.workflowFile.length + 1);
  if (
    !Number.isSafeInteger(body.id) ||
    body.id < 1 ||
    !safeUrl(body.html_url) ||
    !workflowPathMatches ||
    normalizedSha(body.head_sha) !== expected.headSha ||
    body.event !== "workflow_dispatch" ||
    (expected.correlationId !== undefined && body.display_title !== expected.correlationId)
  )
    return null;
  return {
    runId: String(body.id),
    url: body.html_url,
    workflowFile: expected.workflowFile,
    headSha: expected.headSha,
    displayTitle: body.display_title,
    status: body.status,
    conclusion: body.conclusion,
  };
};

export const decodeJson = <A>(schema: Schema.Codec<A, unknown>, text: string) =>
  Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));

export const digestSha256 = (crypto: Crypto.Crypto, bytes: Uint8Array) =>
  crypto.digest("SHA-256", bytes).pipe(
    Effect.map(Hex.encode),
    Effect.mapError((cause) =>
      failed("Couldn't verify the GitHub Actions artifact digest.", cause),
    ),
  );

export const decodedArtifactText = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => failed("The workflow artifact entry isn't valid UTF-8.", cause),
  });

export const pendingDispatch = (cause?: unknown) =>
  failed(
    "The workflow dispatch may have reached GitHub. Its durable attempt stays pending; Signalbox will only read back the matching run and will not dispatch this correlation ID again.",
    cause,
  );

export const pendingIssue = (cause?: unknown) =>
  failed(
    "Issue creation may have reached GitHub. Its durable attempt stays pending; Signalbox will only read back the matching issue and will not create this correlation ID again.",
    cause,
  );

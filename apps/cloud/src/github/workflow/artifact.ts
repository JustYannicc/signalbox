import { AutomationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type GitHubApi } from "../GitHubApi.ts";
import {
  decodedArtifactText,
  digestSha256,
  failed,
  normalizeWorkflowFile,
  normalizedSha,
  toWorkflowRun,
  validRunId,
  validSha,
  validateRepository,
} from "./common.ts";
import {
  extractArtifactEntry,
  isSafeEntryPath,
  MAX_ARTIFACT_ARCHIVE_BYTES,
} from "./artifactZip.ts";
import { makeWorkflowRest } from "./rest.ts";
import type { WorkflowArtifactInput, WorkflowArtifactResult } from "./types.ts";

const isAutomationError = Schema.is(AutomationError);

export const makeWorkflowArtifact = (api: GitHubApi, crypto: Crypto.Crypto) => {
  const rest = makeWorkflowRest(api);

  return (token: string, repository: string, input: WorkflowArtifactInput) =>
    Effect.gen(function* () {
      const workflowFile = normalizeWorkflowFile(input.workflowFile);
      if (workflowFile === null) return yield* failed("Pass a safe GitHub workflow file name.");
      if (!validSha(input.headSha))
        return yield* failed("Pass the full 40-character workflow head SHA.");
      if (!validRunId(input.runId)) return yield* failed("Pass a numeric GitHub Actions run ID.");
      if (!validateRepository(repository))
        return yield* failed("The folder's GitHub repository name is invalid.");
      if (input.artifactName.length === 0 || input.artifactName.length > 256)
        return yield* failed("Pass an exact artifact name.");
      if (!isSafeEntryPath(input.entryPath))
        return yield* failed("Pass an exact relative ZIP entry path.");

      const expectedHead = normalizedSha(input.headSha);
      const runBody = yield* rest.readRun(token, repository, input.runId);
      if (runBody === null) return null;
      const run = toWorkflowRun(runBody, { workflowFile, headSha: expectedHead });
      if (run === null)
        return yield* failed("The GitHub Actions run doesn't match this workflow and head SHA.");
      if (run.status !== "completed") return null;

      const matching = (yield* rest.artifacts(token, repository, input.runId)).filter(
        (artifact) => artifact.name === input.artifactName,
      );
      if (matching.length > 1)
        return yield* failed("More than one artifact in this run has the requested name.");
      const artifact = matching[0];
      if (artifact === undefined || artifact.expired) return null;
      if (
        !Number.isSafeInteger(artifact.id) ||
        artifact.id < 1 ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes < 1
      )
        return yield* failed("GitHub returned invalid artifact metadata.");
      if (artifact.size_in_bytes > MAX_ARTIFACT_ARCHIVE_BYTES)
        return yield* failed("The GitHub Actions artifact exceeds the download size limit.");
      const declaredHash = /^sha256:([a-f0-9]{64})$/iu.exec(artifact.digest)?.[1]?.toLowerCase();
      if (declaredHash === undefined)
        return yield* failed("GitHub didn't provide a SHA-256 artifact digest.");

      const archive = yield* rest.downloadArtifact(token, repository, String(artifact.id));
      if (archive === null) return null;
      if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES)
        return yield* failed("The downloaded GitHub Actions artifact exceeds the size limit.");
      const actualArchiveHash = yield* digestSha256(crypto, archive);
      if (actualArchiveHash !== declaredHash)
        return yield* failed("The downloaded GitHub Actions artifact failed its SHA-256 check.");

      const entry = yield* Effect.tryPromise({
        try: () => extractArtifactEntry(archive, input.entryPath),
        catch: (cause) => failed("Couldn't read the requested artifact ZIP entry.", cause),
      });
      if (entry === null) return null;
      const sha256 = yield* digestSha256(crypto, entry);
      const text = yield* decodedArtifactText(entry);
      return {
        run,
        artifact: {
          id: String(artifact.id),
          name: artifact.name,
          digest: artifact.digest,
          entryPath: input.entryPath,
          sha256,
          bytes: entry.byteLength,
        },
        text,
      } satisfies WorkflowArtifactResult;
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause) ? cause : failed("Couldn't read the workflow artifact.", cause),
      ),
    );
};

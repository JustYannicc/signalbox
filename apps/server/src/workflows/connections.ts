import type { AutomationConnectedService } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { automationError, errorMessage, fail, isAutomationError } from "./errors.ts";
import * as ExecutorSettings from "./executorSettings.ts";
import { toJson } from "./json.ts";
import { explained } from "./runLog.ts";
import { TransientFailure } from "./stepPolicy.ts";

/**
 * `w.call` reaches the services the user connected in Executor. The server
 * holds the Executor URL and API key (see executorSettings.ts); automation code
 * never sees them. Users connect Executor in Settings → Connected services.
 */

const SEGMENT = /^[A-Za-z0-9_$-]+$/;
const CALL_TIMEOUT = "2 minutes";
const LIST_TIMEOUT = "15 seconds";

/** A failure worth retrying: the network, a timeout, or Executor being busy. */
const transient = (message: string, cause?: unknown) =>
  explained(message, {
    fix: "Check that Executor is running and reachable from this server.",
    cause: new TransientFailure(message, { cause }),
  });

/** `gmail.users.messages.list` + connection `work` → the Executor tool path and its integration. */
function executorToolPath(operation: string, connection: string | undefined) {
  const [integration, ...rest] = operation.split(".");
  if (
    !integration ||
    rest.length === 0 ||
    ![integration, ...rest].every((part) => SEGMENT.test(part))
  ) {
    return null;
  }
  if (connection !== undefined && !SEGMENT.test(connection)) return null;
  return { integration, operation: rest.join("."), connection };
}

/** The JS Executor runs for one call: resolve the connection, call the tool, return its data or error. */
function executorCallCode(input: {
  integration: string;
  operation: string;
  connection: string | undefined;
  args: unknown;
}) {
  return `const listed = await tools.executor.coreTools.connections.list({});
if (!listed.ok) return { ok: false, error: "Couldn't list connections: " + listed.error.message };
const wanted = ${toJson(input.connection ?? null)};
const matches = listed.data.connections.filter((c) => c.integration === ${toJson(input.integration)} && (wanted === null || c.name === wanted));
const owned = matches.filter((c) => c.owner === "user");
const pick = (owned.length > 0 ? owned : matches);
if (pick.length === 0) return { ok: false, error: ${toJson(`${input.integration} isn't connected${input.connection ? ` as "${input.connection}"` : ""}.`)} };
if (pick.length > 1) return { ok: false, error: "There are several ${input.integration} connections (" + pick.map((c) => c.name).join(", ") + "); pass { connection: \\"name\\" } to w.call." };
let tool = tools;
for (const part of (pick[0].address.replace(/^tools\\./, "") + "." + ${toJson(input.operation)}).split(".")) tool = tool[part];
const result = await tool(${toJson(input.args ?? {})});
return result && typeof result === "object" && "ok" in result
  ? (result.ok ? { ok: true, value: result.data } : { ok: false, error: result.error?.message ?? "The call failed." })
  : { ok: true, value: result };`;
}

/** The JS Executor runs to list the user's connections. */
export const LIST_CONNECTIONS_CODE = `const listed = await tools.executor.coreTools.connections.list({});
if (!listed.ok) return { ok: false, error: listed.error?.message ?? "Couldn't list connections." };
return { ok: true, value: listed.data.connections.map((c) => ({ integration: c.integration, name: c.name })) };`;

/**
 * Runs `code` on Executor and returns the `{ ok, value }` it settles with.
 * Every failure is an AutomationError whose message the user can act on.
 */
const runExecutor = (
  http: HttpClient.HttpClient,
  settings: Pick<ExecutorSettings.ExecutorSettings, "url" | "apiKey">,
  code: string,
  options: {
    readonly timeout?: Duration.Input;
    /** Let Executor run calls that need approval. Only full-access automations may. */
    readonly autoApprove: boolean;
    /** Sent as `Idempotency-Key`, so a call retried after a restart can be recognized. */
    readonly idempotencyKey?: string;
  },
) =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => new URL("/api/executions", settings.url).toString(),
      catch: () => automationError(`"${settings.url}" isn't a valid Executor URL.`),
    });
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(settings.apiKey),
      options.idempotencyKey
        ? HttpClientRequest.setHeader("idempotency-key", options.idempotencyKey)
        : (request) => request,
      HttpClientRequest.bodyJsonUnsafe({ code, autoApprove: options.autoApprove }),
    );
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? CALL_TIMEOUT,
        orElse: () => Effect.fail(transient(`Executor at ${settings.url} didn't answer in time.`)),
      }),
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : transient(`Couldn't reach Executor at ${settings.url}: ${errorMessage(cause)}`, cause),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError((cause) => transient("Couldn't read Executor's answer.", cause)),
    );
    if (response.status === 401 || response.status === 403)
      return yield* Effect.fail(
        explained("Executor didn't accept the API key.", {
          fix: "Reconnect Executor with a new key in Settings → Connected services.",
        }),
      );
    const body = Option.getOrElse(decodeBody(text), (): ExecutorBody => ({}));
    if (response.status >= 400) {
      const message = `Executor answered ${response.status}: ${body.text ?? ""}`.trim();
      return yield* Effect.fail(
        response.status === 429 || response.status >= 500
          ? transient(message)
          : automationError(message),
      );
    }
    if (body.status === "paused")
      return yield* Effect.fail(
        options.autoApprove
          ? automationError(`Executor wants an approval for this call: ${body.text ?? ""}`)
          : explained(
              "This call needs approval in Executor; save this automation from a full-access thread to allow it.",
              {
                why: "Executor asks before running this call, and only automations saved from a full-access thread may approve calls on their own.",
                fix: "Save the automation again from a full-access thread, or allow the call in Executor.",
              },
            ),
      );
    if (body.structured?.status === "error")
      return yield* fail(body.structured.error ?? "The call failed.");
    const outcome = body.structured?.result as
      | { ok?: boolean; value?: unknown; error?: string }
      | undefined;
    if (!outcome?.ok) return yield* fail(outcome?.error ?? "The call failed.");
    return outcome.value ?? null;
  });

// Executor's answer to POST /api/executions; only the fields read here. JSON nulls count as absent.
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const ExecutorBody = Schema.Struct({
  status: OptionalText,
  structured: Schema.optional(
    Schema.Struct({
      status: OptionalText,
      result: Schema.optional(Schema.Unknown),
      error: OptionalText,
    }),
  ),
  text: OptionalText,
});
type ExecutorBody = typeof ExecutorBody.Type;
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(ExecutorBody));

/** The accounts the user connected in Executor, sorted by integration then name. */
export const listExecutorServices = (
  http: HttpClient.HttpClient,
  settings: Pick<ExecutorSettings.ExecutorSettings, "url" | "apiKey">,
) =>
  runExecutor(http, settings, LIST_CONNECTIONS_CODE, {
    timeout: LIST_TIMEOUT,
    autoApprove: true,
  }).pipe(
    Effect.map((value): ReadonlyArray<AutomationConnectedService> =>
      (Array.isArray(value) ? value : [])
        .filter(
          (entry): entry is AutomationConnectedService =>
            typeof entry?.integration === "string" && typeof entry?.name === "string",
        )
        .map(({ integration, name }) => ({ integration, name }))
        .toSorted(
          (a, b) => a.integration.localeCompare(b.integration) || a.name.localeCompare(b.name),
        ),
    ),
  );

export const makeConnections = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const store = yield* ExecutorSettings.ExecutorSettingsStore;

  /** Calls `operation` on the user's connected service and returns the API's data. */
  const call = (input: {
    readonly operation: string;
    readonly args: unknown;
    readonly connection?: string | undefined;
    readonly autoApprove: boolean;
    readonly idempotencyKey: string;
  }) =>
    Effect.gen(function* () {
      const target = executorToolPath(input.operation, input.connection);
      if (!target) return yield* fail(`"${input.operation}" isn't a valid operation name.`);
      const settings = yield* store.read;
      if (Option.isNone(settings)) {
        return yield* Effect.fail(
          explained(
            "Connected services aren't set up on this server. Connect Executor in Settings → Connected services, or use w.http.",
            {
              fix: "Connect Executor in Settings → Connected services, or call the API with w.http.",
            },
          ),
        );
      }
      return yield* runExecutor(
        http,
        settings.value,
        executorCallCode({ ...target, args: input.args }),
        { autoApprove: input.autoApprove, idempotencyKey: input.idempotencyKey },
      );
    });

  return { call };
});

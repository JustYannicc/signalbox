import {
  AUTOMATION_PATHS,
  automationJson,
  type ToolRequest,
  type ToolResult,
} from "@signalbox/runner-protocol/AutomationProtocol";
import {
  BRANCH_PATHS,
  branchJson,
  type PublishRequest,
  type PublishResult,
} from "@signalbox/runner-protocol/BranchProtocol";
import {
  BROWSER_PATHS,
  type BrowserEndRequest,
  type BrowserSessionAnswer,
  browserJson,
} from "@signalbox/runner-protocol/BrowserProtocol";
import {
  CONTEXT_PATHS,
  type ContextView,
  contextJson,
  type DiffResult,
  type SearchResult,
  type ThreadResult,
  type TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * A thread's machine reading beyond its own drive (`ContextProtocol.ts`):
 * the drives its user can read, and the context tool's search. Every call
 * carries the turn's drive token, which stays in the Runner: the harness
 * reaches all of this through the Runner's local context server
 * (`RunnerContextServer.ts`), never with the token itself. Network failures
 * and 5xx are retried a few times; anything else fails at once.
 *
 * `publish` is the one call that changes anything: the thread's agent asking
 * the cloud to push the thread's branch (`BranchProtocol.ts`). It is safe to
 * retry: pushing a branch that's there and opening a pull request that's open
 * do nothing.
 *
 * `automationTool` forwards an automation tool call (`AutomationProtocol.ts`).
 * Only a read is retried: a write the cloud may have done already would
 * happen twice.
 *
 * `browserSession` gets the thread's session in the person's browser
 * (`BrowserProtocol.ts`), and `endBrowser` deletes it. Both are safe to
 * retry: the cloud reuses the thread's open session and ending one twice
 * does nothing.
 */

export class ContextClientError extends Schema.TaggedError<ContextClientError>()(
  "ContextClientError",
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

export type BlobAnswer =
  | { readonly _tag: "blob"; readonly bytes: Uint8Array }
  | { readonly _tag: "missing" | "too_large" };

export interface ContextClient {
  readonly view: Effect.Effect<ContextView, ContextClientError>;
  readonly tree: (request: {
    readonly driveId: string;
    readonly commit: string;
    readonly path: string;
  }) => Effect.Effect<TreeResult, ContextClientError>;
  readonly blob: (request: {
    readonly driveId: string;
    readonly oid: string;
  }) => Effect.Effect<BlobAnswer, ContextClientError>;
  readonly diff: (request: {
    readonly driveId: string;
    readonly from: string | null;
    readonly to: string;
  }) => Effect.Effect<DiffResult, ContextClientError>;
  readonly search: (request: {
    readonly query: string;
    readonly driveId: string | null;
  }) => Effect.Effect<SearchResult, ContextClientError>;
  readonly thread: (request: {
    readonly threadId: string;
    readonly turn: number | null;
  }) => Effect.Effect<ThreadResult, ContextClientError>;
  readonly publish: (request: PublishRequest) => Effect.Effect<PublishResult, ContextClientError>;
  readonly automationTool: (
    request: ToolRequest,
    options: { readonly retry: boolean },
  ) => Effect.Effect<ToolResult, ContextClientError>;
  readonly browserSession: Effect.Effect<BrowserSessionAnswer, ContextClientError>;
  readonly endBrowser: (request: BrowserEndRequest) => Effect.Effect<void, ContextClientError>;
}

class Retryable extends Schema.TaggedError<Retryable>()("Retryable", { message: Schema.String }) {}

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do). */
export const makeContextClient = Effect.fn("makeContextClient")(function* (input: {
  readonly cloudUrl: string;
  readonly access: DriveAccess;
}) {
  const http = yield* HttpClient.HttpClient;
  const origin = input.cloudUrl.replace(/\/+$/, "");

  /** POSTs `body`, answering the status and body bytes; retries what may pass on a second try. */
  const post = (path: string, body: string, retry = true) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${origin}${path}`).pipe(
            HttpClientRequest.bearerToken(input.access.token),
            HttpClientRequest.bodyText(body, "application/json"),
          ),
        )
        .pipe(Effect.mapError((error) => new Retryable({ message: error.message })));
      if (response.status >= 500 || response.status === 429) {
        return yield* new Retryable({ message: `HTTP ${response.status}` });
      }
      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError((error) => new Retryable({ message: error.message })),
        ),
      );
      return { status: response.status, bytes };
    }).pipe(
      Effect.retry({ times: retry ? 4 : 0, schedule: Schedule.exponential("250 millis") }),
      Effect.mapError(
        (error) =>
          new ContextClientError({ message: `The drives are unreachable: ${error.message}` }),
      ),
    );

  const json =
    <I, A>(
      path: string,
      encode: (request: I) => string,
      decode: (text: string) => A,
      retry = true,
    ) =>
    (request: I) =>
      Effect.gen(function* () {
        const answer = yield* post(path, encode(request), retry);
        const text = new TextDecoder().decode(answer.bytes);
        if (answer.status !== 200) {
          return yield* new ContextClientError({
            message: text.slice(0, 500),
            status: answer.status,
          });
        }
        return yield* Effect.try({
          try: () => decode(text),
          // It answered, so whatever it was asked to do happened.
          catch: () =>
            new ContextClientError({ message: "The drives sent a malformed answer.", status: 200 }),
        });
      });

  const blob: ContextClient["blob"] = (request) =>
    Effect.gen(function* () {
      const answer = yield* post(CONTEXT_PATHS.blob, contextJson.blobRequest.encode(request));
      switch (answer.status) {
        case 200:
          return { _tag: "blob", bytes: answer.bytes } as const;
        case 404:
          return { _tag: "missing" } as const;
        case 413:
          return { _tag: "too_large" } as const;
        default:
          return yield* new ContextClientError({
            message: new TextDecoder().decode(answer.bytes).slice(0, 500),
            status: answer.status,
          });
      }
    });

  const automationTool = (retry: boolean) =>
    json(
      AUTOMATION_PATHS.tool,
      automationJson.toolRequest.encode,
      automationJson.tool.decode,
      retry,
    );
  const automationRead = automationTool(true);
  const automationWrite = automationTool(false);

  return {
    view: json(CONTEXT_PATHS.view, () => "{}", contextJson.view.decode)(undefined),
    tree: json(CONTEXT_PATHS.tree, contextJson.treeRequest.encode, contextJson.tree.decode),
    blob,
    diff: json(CONTEXT_PATHS.diff, contextJson.diffRequest.encode, contextJson.diff.decode),
    search: json(CONTEXT_PATHS.search, contextJson.searchRequest.encode, contextJson.search.decode),
    thread: json(CONTEXT_PATHS.thread, contextJson.threadRequest.encode, contextJson.thread.decode),
    publish: json(
      BRANCH_PATHS.publish,
      branchJson.publishRequest.encode,
      branchJson.publish.decode,
    ),
    automationTool: (request, { retry }) => (retry ? automationRead : automationWrite)(request),
    browserSession: json(BROWSER_PATHS.session, () => "{}", browserJson.session.decode)(undefined),
    endBrowser: json(BROWSER_PATHS.end, browserJson.endRequest.encode, constVoid),
  } satisfies ContextClient;
});

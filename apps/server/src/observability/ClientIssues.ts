import { ProjectId, ThreadId, WsRpcGroup, type AuthSessionId } from "@t3tools/contracts";
import type { ClientIssue } from "@t3tools/contracts/clientIssues";
import * as ClientIssueContract from "@t3tools/contracts/clientIssues";
import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 30;
const MAX_TRACKED_SESSIONS = 8_192;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_COUNT = 5;

export class ClientIssuePayloadError extends Schema.TaggedError<ClientIssuePayloadError>()(
  "ClientIssuePayloadError",
  {},
) {
  override get message(): string {
    return "The client issue report is invalid.";
  }
}

export class ClientIssueRateLimitedError extends Schema.TaggedError<ClientIssueRateLimitedError>()(
  "ClientIssueRateLimitedError",
  {},
) {
  override get message(): string {
    return "The client issue report rate limit was reached.";
  }
}

export class ClientIssuePersistenceError extends Schema.TaggedError<ClientIssuePersistenceError>()(
  "ClientIssuePersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to persist client issue metadata.";
  }
}

type ClientIssueError =
  | ClientIssuePayloadError
  | ClientIssueRateLimitedError
  | ClientIssuePersistenceError;

interface RateWindow {
  readonly endsAt: number;
  readonly count: number;
}

const ClientIssueEventSchema = Schema.Struct({
  type: Schema.Literal("client.issue"),
  occurredAt: Schema.String,
  environmentId: Schema.String,
  release: Schema.String.check(Schema.isMaxLength(128)),
  clientRelease: ClientIssueContract.ClientIssue.fields.release,
  code: ClientIssueContract.ClientIssue.fields.code,
  severity: ClientIssueContract.ClientIssue.fields.severity,
  source: ClientIssueContract.ClientIssue.fields.source,
  client: ClientIssueContract.ClientIssue.fields.client,
  threadId: ClientIssueContract.ClientIssue.fields.threadId,
  folderId: ClientIssueContract.ClientIssue.fields.folderId,
  traceId: ClientIssueContract.ClientIssue.fields.traceId,
  spanId: ClientIssueContract.ClientIssue.fields.spanId,
  method: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Number),
});
type ClientIssueEvent = typeof ClientIssueEventSchema.Type;
const encodeClientIssueEvent = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ClientIssueEventSchema),
);
const decodeClientIssue = Schema.decodeEffect(ClientIssueContract.ClientIssue);

export class ClientIssues extends Context.Service<
  ClientIssues,
  {
    readonly report: (input: {
      readonly issue: ClientIssue;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<void, ClientIssueError>;
  }
>()("t3/observability/ClientIssues") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environmentId = yield* environment.getEnvironmentId;
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: path.join(config.logsDir, "client-issues", "events.ndjson"),
    maxBytes: MAX_FILE_BYTES,
    maxFiles: MAX_FILE_COUNT,
  }).pipe(Effect.mapError((cause) => new ClientIssuePersistenceError({ cause })));
  const rateWindows = yield* SynchronizedRef.make(new Map<string, RateWindow>());
  const knownMethods = new Set(WsRpcGroup.requests.keys());

  const consumeRateLimit = Effect.fnUntraced(function* (sessionId: AuthSessionId) {
    const now = yield* Clock.currentTimeMillis;
    const allowed = yield* SynchronizedRef.modify(rateWindows, (current) => {
      const next = new Map(current);
      for (const [key, window] of next) {
        if (window.endsAt <= now) next.delete(key);
      }

      const currentWindow = next.get(sessionId);
      if (currentWindow !== undefined && currentWindow.count >= MAX_REPORTS_PER_WINDOW) {
        return [false, next] as const;
      }
      if (currentWindow === undefined) {
        next.set(sessionId, { endsAt: now + RATE_WINDOW_MS, count: 1 });
      } else {
        next.set(sessionId, { ...currentWindow, count: currentWindow.count + 1 });
      }

      while (next.size > MAX_TRACKED_SESSIONS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return [true, next] as const;
    });
    if (!allowed) return yield* new ClientIssueRateLimitedError();
  });

  const projectIdIfReadable = (id: string) =>
    projects
      .getById(ProjectId.make(id))
      .pipe(Effect.map(Option.map((project) => project.id)), Effect.orElseSucceed(Option.none));

  const resolveReferences = Effect.fnUntraced(function* (issue: ClientIssue) {
    if (issue.threadId !== null) {
      const thread = yield* threads
        .getThreadShell(ThreadId.make(issue.threadId))
        .pipe(Effect.orElseSucceed(() => null));
      if (thread !== null) {
        const folderId = yield* projectIdIfReadable(thread.projectId);
        return {
          threadId: thread.id,
          folderId: Option.getOrNull(folderId),
        };
      }
      return { threadId: null, folderId: null };
    }

    if (issue.folderId !== null) {
      const folderId = yield* projectIdIfReadable(issue.folderId);
      return { threadId: null, folderId: Option.getOrNull(folderId) };
    }
    return { threadId: null, folderId: null };
  });

  const report: ClientIssues["Service"]["report"] = Effect.fn("ClientIssues.report")(function* ({
    issue: inputIssue,
    sessionId,
  }) {
    const issue = yield* decodeClientIssue(inputIssue).pipe(
      Effect.mapError(() => new ClientIssuePayloadError()),
    );
    const method =
      (issue.source === "rpc" || issue.source === "subscription") &&
      issue.method !== undefined &&
      knownMethods.has(issue.method)
        ? issue.method
        : undefined;
    yield* consumeRateLimit(sessionId);

    const references = yield* resolveReferences(issue);
    const event: ClientIssueEvent = {
      type: "client.issue",
      occurredAt: DateTime.formatIso(yield* DateTime.now),
      environmentId,
      release: packageJson.version,
      clientRelease: issue.release,
      code: issue.code,
      severity: issue.severity,
      source: issue.source,
      client: issue.client,
      ...references,
      traceId: issue.traceId,
      spanId: issue.spanId,
      ...(method === undefined ? {} : { method }),
      ...(issue.durationMs === undefined ? {} : { durationMs: issue.durationMs }),
    };
    const line = yield* encodeClientIssueEvent(event).pipe(
      Effect.mapError((cause) => new ClientIssuePersistenceError({ cause })),
    );
    yield* sink
      .write(`${line}\n`)
      .pipe(Effect.mapError((cause) => new ClientIssuePersistenceError({ cause })));
  });

  return ClientIssues.of({ report });
});

export const layer = Layer.effect(ClientIssues, make);

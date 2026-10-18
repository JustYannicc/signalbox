import { AuthOrchestrationReadScope, WsRpcGroup } from "@t3tools/contracts";
import { ClientIssue as ClientIssueSchema } from "@t3tools/contracts/clientIssues";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import type { ClientIssue as ClientIssueContract } from "@t3tools/contracts/clientIssues";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientTraceLimits from "./ClientTraceLimits.ts";
import * as ClientIssueTraces from "./ClientIssueTraces.ts";
import * as Evlog from "./Evlog.ts";

const MAX_BYTES = 16 * 1024;
const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i;
const SAFE_ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ClientIssueInput = ClientIssueContract;
type TrustedDimensions = {
  readonly threadId: string | null;
  readonly folderId: string | null;
  readonly orgId: string | null;
};

export class ClientIssueRejected extends Schema.TaggedError<ClientIssueRejected>()(
  "ClientIssueRejected",
  { status: Schema.Literals([400, 403, 408, 413, 415, 429, 503]) },
) {}

export class ClientIssueIntake extends Context.Service<
  ClientIssueIntake,
  {
    readonly ingest: (input: {
      readonly credentials: Parameters<CloudSessions.CloudSessions["Service"]["authenticate"]>[0];
      readonly contentType: string | undefined;
      readonly contentEncoding: string | undefined;
      readonly contentLength: string | undefined;
      readonly traceparent: string | undefined;
      readonly body: Stream.Stream<Uint8Array, unknown>;
    }) => Effect.Effect<void, ClientIssueRejected | CloudSessions.CloudCredentialError>;
  }
>()("@signalbox/cloud/observability/ClientIssueIntake") {}

export const isClientIssueRejected = Schema.is(ClientIssueRejected);

const make = Effect.gen(function* () {
  const users = yield* UserDirectory.UserDirectory;
  const sessions = yield* CloudSessions.CloudSessions;
  const exporter = yield* ClientTraceExport.ClientTraceExport;
  const limits = yield* ClientTraceLimits.ClientTraceLimits;
  const stage = yield* Config.String("SIGNALBOX_STAGE").pipe(Config.withDefault("development"));
  const release = yield* Config.String("APP_VERSION").pipe(Config.withDefault("development"));
  const environmentId = yield* Config.String("ENVIRONMENT_ID").pipe(Config.withDefault(""));
  const enabled = yield* Config.String("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault("true"));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientIssueSchema));

  const ingest: ClientIssueIntake["Service"]["ingest"] = Effect.fnUntraced(function* (input) {
    const session = yield* sessions.authenticate(input.credentials).pipe(
      Effect.catchTags({
        UserObjectError: () => Effect.fail(new ClientIssueRejected({ status: 503 })),
      }),
    );
    if (!session.scopes.includes(AuthOrchestrationReadScope))
      return yield* new ClientIssueRejected({ status: 403 });
    if (!(yield* limits.allow(`client-issue:${session.userId}`)))
      return yield* new ClientIssueRejected({ status: 429 });
    if (
      input.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      (input.contentEncoding !== undefined &&
        input.contentEncoding.trim().toLowerCase() !== "identity")
    )
      return yield* new ClientIssueRejected({ status: 415 });
    if (
      input.contentLength !== undefined &&
      (!/^\d+$/.test(input.contentLength) || Number(input.contentLength) > MAX_BYTES)
    )
      return yield* new ClientIssueRejected({ status: 413 });
    if (enabled.trim().toLowerCase() === "false") return yield* Effect.void;

    const bytes = yield* input.body.pipe(
      Stream.runFoldEffect(
        () => new Uint8Array(0),
        (body, chunk) => {
          if (body.length + chunk.length > MAX_BYTES)
            return Effect.fail(new ClientIssueRejected({ status: 413 }));
          const next = new Uint8Array(body.length + chunk.length);
          next.set(body);
          next.set(chunk, body.length);
          return Effect.succeed(next);
        },
      ),
      Effect.mapError((cause) =>
        isClientIssueRejected(cause) ? cause : new ClientIssueRejected({ status: 400 }),
      ),
      Effect.timeout("5 seconds"),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new ClientIssueRejected({ status: 408 })),
      }),
    );
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new ClientIssueRejected({ status: 400 }),
    });
    const decoded = yield* decode(text).pipe(
      Effect.mapError(() => new ClientIssueRejected({ status: 400 })),
    );
    if (input.traceparent !== undefined) {
      const match = TRACEPARENT.exec(input.traceparent.trim());
      if (
        match === null ||
        match[1]?.toLowerCase() !== decoded.traceId ||
        match[2]?.toLowerCase() !== decoded.spanId
      )
        return yield* new ClientIssueRejected({ status: 400 });
    }

    const dimensions = yield* resolveDimensions(users.forUser(session.userId), decoded).pipe(
      Effect.mapError(() => new ClientIssueRejected({ status: 503 })),
    );
    const method =
      (decoded.source === "rpc" || decoded.source === "subscription") &&
      decoded.method !== undefined &&
      WsRpcGroup.requests.has(decoded.method)
        ? decoded.method
        : undefined;
    const issue = reconstructIssue(decoded, dimensions, method, safeEnvironmentId(environmentId));

    yield* Effect.asVoid(
      report(issue, session.userId, dimensions.orgId, { stage, release }, exporter),
    );
  });
  return ClientIssueIntake.of({ ingest });
});

const resolveDimensions = (
  user: UserDirectory.UserHandle,
  issue: ClientIssueInput,
): Effect.Effect<TrustedDimensions, UserDirectory.UserObjectError> => {
  if (issue.threadId !== null) {
    return user.clientTraceDimensions([issue.threadId]).pipe(
      Effect.map((dimensions) => {
        const found = dimensions[0];
        return {
          threadId: found?.threadId ?? null,
          folderId: found?.folderId ?? null,
          orgId: found?.orgId ?? null,
        };
      }),
    );
  }
  if (issue.folderId !== null) {
    return user.clientFolderDimensions([issue.folderId]).pipe(
      Effect.map((dimensions) => ({
        threadId: null,
        folderId: dimensions[0]?.folderId ?? null,
        orgId: dimensions[0]?.orgId ?? null,
      })),
    );
  }
  return Effect.succeed({ threadId: null, folderId: null, orgId: null });
};

const safeEnvironmentId = (value: string) => (SAFE_ENVIRONMENT_ID.test(value) ? value : null);

const reconstructIssue = (
  input: ClientIssueInput,
  dimensions: TrustedDimensions,
  method: string | undefined,
  environmentId: string | null,
): ClientIssueInput => ({
  code: input.code,
  severity: input.severity,
  source: input.source,
  client: input.client,
  release: input.release,
  threadId: dimensions.threadId,
  folderId: dimensions.folderId,
  environmentId,
  traceId: input.traceId,
  spanId: input.spanId,
  ...(input.existingSpan === undefined ? {} : { existingSpan: input.existingSpan }),
  ...(method === undefined ? {} : { method }),
  ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
});

const report = (
  issue: ClientIssueInput,
  personId: string,
  orgId: string | null,
  trusted: { readonly stage: string; readonly release: string },
  exporter: ClientTraceExport.ClientTraceExport["Service"],
) =>
  Effect.gen(function* () {
    const serverSpan = yield* Effect.orDie(Effect.currentSpan);
    const issueFields = {
      code: issue.code,
      severity: issue.severity,
      source: issue.source,
      client: issue.client,
      clientRelease: issue.release,
      release: trusted.release,
      stage: trusted.stage,
      environmentId: issue.environmentId,
      threadId: issue.threadId,
      folderId: issue.folderId,
      traceId: issue.traceId,
      spanId: issue.spanId,
      serverSpanId: serverSpan.spanId,
      ...(issue.method === undefined ? {} : { method: issue.method }),
      ...(issue.durationMs === undefined ? {} : { durationMs: issue.durationMs }),
    };
    const fields = {
      person: { id: personId },
      ...(orgId === null ? {} : { org: { id: orgId } }),
      clientIssue: issueFields,
      ...(issue.threadId === null ? {} : { thread: { id: issue.threadId } }),
      ...(issue.folderId === null ? {} : { folder: { id: issue.folderId } }),
    };

    const action = `client.issue.${issue.code}`;
    const logIssue =
      issue.severity === "error" ? Effect.logError(action) : Effect.logWarning(action);
    yield* Evlog.withUnit(action, fields)(logIssue);

    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const trace = ClientIssueTraces.make(
      issue,
      personId,
      serverSpan.spanId,
      BigInt(nowMs) * 1_000_000n,
      orgId,
    );
    yield* exporter.submit(trace).pipe(Effect.exit, Effect.asVoid);
  }).pipe(
    Effect.withSpan("client.issue.intake"),
    Effect.withParentSpan(Tracer.externalSpan({ traceId: issue.traceId, spanId: issue.spanId })),
  );

export const layer = Layer.effect(ClientIssueIntake, make);

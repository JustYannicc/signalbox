import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientTraceLimits from "./ClientTraceLimits.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudSessions from "../auth/CloudSessions.ts";
import { ClientTraces, safeClientTraces } from "./clientTraces.ts";

const MAX_BYTES = 128 * 1024;

export class ClientTraceRejected extends Schema.TaggedError<ClientTraceRejected>()(
  "ClientTraceRejected",
  { status: Schema.Number },
) {}

export class ClientTraceIntake extends Context.Service<
  ClientTraceIntake,
  {
    readonly ingest: (input: {
      readonly credentials: Parameters<CloudSessions.CloudSessions["Service"]["authenticate"]>[0];
      readonly contentType: string | undefined;
      readonly contentEncoding: string | undefined;
      readonly contentLength: string | undefined;
      readonly body: Stream.Stream<Uint8Array, unknown>;
    }) => Effect.Effect<void, ClientTraceRejected | CloudSessions.CloudCredentialError>;
  }
>()("@signalbox/cloud/observability/ClientTraceIntake") {}

const isClientTraceRejected = Schema.is(ClientTraceRejected);

const make = Effect.gen(function* () {
  const users = yield* UserDirectory.UserDirectory;
  const sessions = yield* CloudSessions.CloudSessions;
  const exporter = yield* ClientTraceExport.ClientTraceExport;
  const limits = yield* ClientTraceLimits.ClientTraceLimits;
  const environment = yield* Config.String("SIGNALBOX_STAGE").pipe(
    Config.withDefault("development"),
  );
  const release = yield* Config.String("APP_VERSION").pipe(Config.withDefault("development"));
  const enabled = yield* Config.String("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault("true"));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientTraces));
  const reject = (status: number) => new ClientTraceRejected({ status });

  const ingest: ClientTraceIntake["Service"]["ingest"] = Effect.fnUntraced(function* (input) {
    const session = yield* sessions
      .authenticate(input.credentials)
      .pipe(Effect.catchTags({ UserObjectError: () => Effect.fail(reject(503)) }));
    if (!(yield* limits.allow(session.userId))) return yield* reject(429);
    if (
      input.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      (input.contentEncoding && input.contentEncoding !== "identity")
    )
      return yield* reject(415);
    if (
      input.contentLength !== undefined &&
      (!/^\d+$/.test(input.contentLength) || Number(input.contentLength) > MAX_BYTES)
    )
      return yield* reject(413);
    if (enabled === "false") return;
    const bytes = yield* input.body.pipe(
      Stream.runFoldEffect(
        () => new Uint8Array(0),
        (body, chunk) => {
          if (body.length + chunk.length > MAX_BYTES) return Effect.fail(reject(413));
          const next = new Uint8Array(body.length + chunk.length);
          next.set(body);
          next.set(chunk, body.length);
          return Effect.succeed(next);
        },
      ),
      Effect.mapError((error) => (isClientTraceRejected(error) ? error : reject(400))),
      Effect.timeout("5 seconds"),
      Effect.catchTags({ TimeoutError: () => Effect.fail(reject(408)) }),
    );
    const inputTraces = yield* decode(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => reject(400)),
    );
    const spanCount = inputTraces.resourceSpans.reduce(
      (count, resource) =>
        count + resource.scopeSpans.reduce((total, scope) => total + scope.spans.length, 0),
      0,
    );
    if (spanCount > 256) return yield* reject(400);
    const threadIds = [
      ...new Set(
        inputTraces.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.flatMap((span) =>
              (span.attributes ?? []).flatMap((attribute) =>
                attribute.key === "thread.id" && attribute.value.stringValue
                  ? [attribute.value.stringValue]
                  : [],
              ),
            ),
          ),
        ),
      ),
    ];
    const dimensions =
      threadIds.length === 0
        ? []
        : yield* users
            .forUser(session.userId)
            .clientTraceDimensions(threadIds)
            .pipe(Effect.mapError(() => reject(503)));
    const traces = safeClientTraces(inputTraces, session.userId, environment, release, dimensions);
    if (traces === null) return yield* reject(400);
    yield* exporter.submit(traces).pipe(Effect.mapError(({ status }) => reject(status)));
  });
  return ClientTraceIntake.of({ ingest });
});

export const layer = Layer.effect(ClientTraceIntake, make);

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
  { status: Schema.Number, cause: Schema.optional(Schema.Defect()) },
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

export const isClientTraceRejected = Schema.is(ClientTraceRejected);

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

  const ingest: ClientTraceIntake["Service"]["ingest"] = Effect.fnUntraced(function* (input) {
    const session = yield* sessions
      .authenticate(input.credentials)
      .pipe(
        Effect.catchTags({
          UserObjectError: (cause) => Effect.fail(new ClientTraceRejected({ status: 503, cause })),
        }),
      );
    if (!(yield* limits.allow(session.userId)))
      return yield* new ClientTraceRejected({ status: 429 });
    if (
      input.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      (input.contentEncoding && input.contentEncoding !== "identity")
    )
      return yield* new ClientTraceRejected({ status: 415 });
    if (
      input.contentLength !== undefined &&
      (!/^\d+$/.test(input.contentLength) || Number(input.contentLength) > MAX_BYTES)
    )
      return yield* new ClientTraceRejected({ status: 413 });
    if (enabled === "false") return;
    const bytes = yield* input.body.pipe(
      Stream.runFoldEffect(
        () => new Uint8Array(0),
        (body, chunk) => {
          if (body.length + chunk.length > MAX_BYTES)
            return Effect.fail(new ClientTraceRejected({ status: 413 }));
          const next = new Uint8Array(body.length + chunk.length);
          next.set(body);
          next.set(chunk, body.length);
          return Effect.succeed(next);
        },
      ),
      Effect.mapError((cause) =>
        isClientTraceRejected(cause) ? cause : new ClientTraceRejected({ status: 400, cause }),
      ),
      Effect.timeout("5 seconds"),
      Effect.catchTags({
        TimeoutError: (cause) => Effect.fail(new ClientTraceRejected({ status: 408, cause })),
      }),
    );
    const inputTraces = yield* decode(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError((cause) => new ClientTraceRejected({ status: 400, cause })),
    );
    const spanCount = inputTraces.resourceSpans.reduce(
      (count, resource) =>
        count + resource.scopeSpans.reduce((total, scope) => total + scope.spans.length, 0),
      0,
    );
    if (spanCount > 256) return yield* new ClientTraceRejected({ status: 400 });
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
            .pipe(Effect.mapError((cause) => new ClientTraceRejected({ status: 503, cause })));
    const traces = safeClientTraces(inputTraces, session.userId, environment, release, dimensions);
    if (traces === null) return yield* new ClientTraceRejected({ status: 400 });
    yield* exporter
      .submit(traces)
      .pipe(Effect.mapError((cause) => new ClientTraceRejected({ status: cause.status, cause })));
  });
  return ClientTraceIntake.of({ ingest });
});

export const layer = Layer.effect(ClientTraceIntake, make);

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { ClientTraces, safeClientTraces } from "./clientTraces.ts";

const MAX_BYTES = 128 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const MAX_PEOPLE = 1000;

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
  const sessions = yield* CloudSessions.CloudSessions;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const dsn = yield* Config.Redacted("SENTRY_DSN").pipe(Config.withDefault(Redacted.make("")));
  const environment = yield* Config.String("SIGNALBOX_STAGE").pipe(
    Config.withDefault("development"),
  );
  const release = yield* Config.String("APP_VERSION").pipe(Config.withDefault("development"));
  const enabled = yield* Config.String("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault("true"));
  const limits = new Map<string, { start: number; count: number }>();
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientTraces));
  const reject = (status: number) => new ClientTraceRejected({ status });

  const ingest: ClientTraceIntake["Service"]["ingest"] = Effect.fnUntraced(function* (input) {
    const session = yield* sessions
      .authenticate(input.credentials)
      .pipe(Effect.catchTags({ UserObjectError: () => Effect.fail(reject(503)) }));
    const now = yield* Clock.currentTimeMillis;
    for (const [key, value] of limits) if (now - value.start >= WINDOW_MS) limits.delete(key);
    const bucket = limits.get(session.userId);
    if ((bucket?.count ?? 0) >= MAX_REQUESTS || (!bucket && limits.size >= MAX_PEOPLE))
      return yield* reject(429);
    limits.set(session.userId, { start: bucket?.start ?? now, count: (bucket?.count ?? 0) + 1 });
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
    const destination = yield* Effect.try({
      try: () => {
        const url = new URL(Redacted.value(dsn));
        const segments = url.pathname.split("/").filter(Boolean);
        const project = segments.pop();
        if (url.protocol !== "https:" || !url.username || !project) throw new Error("Invalid DSN");
        return {
          url: `${url.origin}${segments.map((part) => `/${part}`).join("")}/api/${project}/integration/otlp/v1/traces`,
          key: url.username,
        };
      },
      catch: () => reject(503),
    });
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
    const traces = safeClientTraces(inputTraces, session.userId, environment, release);
    if (traces === null) return yield* reject(400);
    yield* HttpClientRequest.post(destination.url).pipe(
      HttpClientRequest.setHeader("x-sentry-auth", `sentry sentry_key=${destination.key}`),
      HttpClientRequest.bodyJson(traces),
      Effect.flatMap(http.execute),
      Effect.timeout("5 seconds"),
      Effect.mapError(() => reject(502)),
    );
  });
  return ClientTraceIntake.of({ ingest });
});

export const layer = Layer.effect(ClientTraceIntake, make);

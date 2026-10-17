import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface TraceExportEnv {
  readonly TRACE_EXPORT?: Pick<Fetcher, "fetch">;
  readonly TRACE_EXPORT_TOKEN?: string;
  readonly T3CODE_TELEMETRY_ENABLED?: string;
  readonly SIGNALBOX_STAGE?: string;
  readonly APP_VERSION?: string;
}

export class ClientTraceExportError extends Schema.TaggedError<ClientTraceExportError>()(
  "ClientTraceExportError",
  { status: Schema.Literals([502, 503]), cause: Schema.optional(Schema.Defect()) },
) {}

export class ClientTraceExport extends Context.Service<
  ClientTraceExport,
  {
    readonly submit: (payload: unknown) => Effect.Effect<void, ClientTraceExportError>;
  }
>()("@signalbox/cloud/observability/ClientTraceExport") {}

const encode = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Only the common filtering Worker can deliver traces. Missing bindings never fall back to Sentry. */
export const layer = (env: TraceExportEnv) =>
  Layer.succeed(ClientTraceExport, {
    submit: (payload) =>
      Effect.gen(function* () {
        if (env.T3CODE_TELEMETRY_ENABLED === "false") return;
        const binding = env.TRACE_EXPORT;
        const token = env.TRACE_EXPORT_TOKEN;
        if (!binding || !token) return yield* new ClientTraceExportError({ status: 503 });
        const body = yield* encode(payload).pipe(
          Effect.mapError((cause) => new ClientTraceExportError({ status: 502, cause })),
        );
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            binding.fetch(
              new Request("https://trace-export/v1/traces", {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body,
                signal,
              }),
            ),
          catch: (cause) => new ClientTraceExportError({ status: 502, cause }),
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new ClientTraceExportError({ status: 502, cause })),
          }),
        );
        if (!response.ok) return yield* new ClientTraceExportError({ status: 502 });
      }),
  });

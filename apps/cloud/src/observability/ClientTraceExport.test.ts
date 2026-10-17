import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientTraceLimits from "./ClientTraceLimits.ts";

describe("client trace delivery boundaries", () => {
  it.effect("never falls back to direct Sentry without the authenticated filtering binding", () =>
    Effect.gen(function* () {
      const exporter = yield* ClientTraceExport.ClientTraceExport;
      const result = yield* exporter.submit({ resourceSpans: [] }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ClientTraceExportError", status: 503 },
      });
    }).pipe(Effect.provide(ClientTraceExport.layer({}))),
  );

  it.effect("honors telemetry opt-out even with a configured collector", () => {
    let called = false;
    return ClientTraceExport.ClientTraceExport.use((exporter) =>
      exporter.submit({ resourceSpans: [] }),
    ).pipe(
      Effect.provide(
        ClientTraceExport.layer({
          T3CODE_TELEMETRY_ENABLED: "false",
          TRACE_EXPORT_TOKEN: "key",
          TRACE_EXPORT: {
            fetch: async () => {
              called = true;
              return new Response(null, { status: 200 });
            },
          },
        }),
      ),
      Effect.andThen(Effect.sync(() => expect(called).toBe(false))),
    );
  });

  it.effect("fails closed if the shared rate limiter is missing", () =>
    ClientTraceLimits.ClientTraceLimits.use((limits) =>
      limits.allow("user_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ).pipe(
      Effect.provide(ClientTraceLimits.layer(undefined)),
      Effect.tap((allowed) => Effect.sync(() => expect(allowed).toBe(false))),
    ),
  );
});

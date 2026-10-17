import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";

import { clientThreadAttributes, contentFreeTracer } from "./clientTraceSafety.ts";

const CANARY = "message-file-secret-canary";

describe("client trace privacy", () => {
  it("extracts only a generated thread ID from RPC inputs", () => {
    const threadId = "7b2dd8b5-cfee-49a1-86ce-bac041bf43b1";
    expect(clientThreadAttributes({ command: { threadId, message: CANARY } })).toEqual({
      "thread.id": threadId,
    });
    expect(clientThreadAttributes({ threadId, file: CANARY })).toEqual({ "thread.id": threadId });
    expect(clientThreadAttributes({ threadId: CANARY })).toEqual({});
  });
  it.effect(
    "removes content before OTLP serialization without changing the trace identity or failure",
    () => {
      let exported = "";
      let traceId = "";
      let spanId = "";
      const failure = new Error(CANARY);
      const deps = Layer.mergeAll(
        OtlpSerialization.layerJson,
        OtlpExporter.layerFlusher,
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, async (_url, init) => {
              exported += new TextDecoder().decode(init?.body as Uint8Array);
              return new Response(null, { status: 200 });
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const tracer = contentFreeTracer(
          yield* OtlpTracer.make({
            url: "https://intake.test/api/observability/v1/traces",
            resource: { serviceName: "test" },
          }),
        );
        const result = yield* Effect.gen(function* () {
          const span = yield* Effect.currentSpan;
          traceId = span.traceId;
          spanId = span.spanId;
          yield* Effect.annotateCurrentSpan({
            message: CANARY,
            file: { content: CANARY },
            "thread.id": "7b2dd8b5-cfee-49a1-86ce-bac041bf43b1",
            "http.response.status_code": 503,
            "url.full": `https://app.test/callback?code=${CANARY}&state=${CANARY}&token=${CANARY}`,
            "http.url": `https://app.test/callback?access_token=${CANARY}&refresh_token=${CANARY}`,
            "http.request.header.authorization": `Bearer ${CANARY}`,
            "http.request.header.cookie": `session=${CANARY}`,
          });
          span.event(CANARY, 0n, { payload: CANARY });
          return yield* Effect.fail(failure);
        }).pipe(
          Effect.withSpan(CANARY),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBe(failure);
      }).pipe(
        Effect.scoped,
        Effect.provide(deps),
        Effect.andThen(
          Effect.sync(() => {
            expect(exported).not.toContain(CANARY);
            expect(exported).toContain(traceId);
            expect(exported).toContain(spanId);
            expect(exported).toContain("7b2dd8b5-cfee-49a1-86ce-bac041bf43b1");
            expect(exported).toContain("client.operation");
          }),
        ),
      );
    },
  );
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as ClientTracer from "../observability/clientTracer";
import { runtime } from "./runtime";

describe("web runtime", () => {
  it("routes client spans to the exporter client tracing configured", async () => {
    const exported: Array<string> = [];
    ClientTracer.setDelegate(
      Tracer.make({
        span(options) {
          exported.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );

    try {
      await runtime.runPromise(Effect.void.pipe(Effect.withSpan("client.work")));
    } finally {
      ClientTracer.setDelegate(null);
    }

    expect(exported).toEqual(["client.work"]);
  });

  it("scrubs URL attributes before client spans reach the exporter", async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    ClientTracer.setDelegate(
      Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    );

    try {
      await runtime.runPromise(
        Effect.void.pipe(
          Effect.withSpan("client.oauth.callback", {
            attributes: {
              "url.full": "https://auth.example.test/callback?code=oauth-code#state=oauth-state",
              "url.query": "access_token=access-token",
              "request.id": "request-123",
            },
          }),
        ),
      );
    } finally {
      ClientTracer.setDelegate(null);
    }

    expect(spans[0]?.attributes.get("url.full")).toBe("https://auth.example.test/callback");
    expect(spans[0]?.attributes.get("url.query")).toBe("[REDACTED]");
    expect(spans[0]?.attributes.get("request.id")).toBe("request-123");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  delivery: Promise.withResolvers<void>(),
  sent: 0,
}));

vi.mock("../../evlog.config.ts", async () => {
  const { defineEvlog } = await import("evlog");
  const { createDrainPipeline } = await import("evlog/pipeline");
  const drain = createDrainPipeline({ batch: { size: 50, intervalMs: 1000 } })(async (batch) => {
    state.sent += batch.length;
    await state.delivery.promise;
  });
  return { drain, default: defineEvlog({ silent: true, drain }) };
});

import worker, { type ModelGatewayEnv } from "./worker.ts";

const env: ModelGatewayEnv = {
  GRANTS: {
    serve: async () => ({
      _tag: "granted-local",
      userId: "person-1",
      keyId: "key-1",
      authMs: 0,
      reply: { _tag: "forwarded", response: new Response("ok"), upstreamMs: 0 },
    }),
    report: async () => undefined,
  },
};

describe("ModelGateway drain lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.delivery = Promise.withResolvers<void>();
    state.sent = 0;
  });

  afterEach(() => {
    state.delivery.resolve();
    vi.useRealTimers();
  });

  it.each(["unrecognized path", "completed stream"])(
    "keeps %s alive until the batched network send completes",
    async (scenario) => {
      const pending: Array<Promise<unknown>> = [];
      const request =
        scenario === "completed stream"
          ? new Request("https://gateway.test/openai/v1/models", {
              headers: { authorization: "Bearer sbk_test" },
            })
          : new Request("https://gateway.test/missing");
      const response = await worker.fetch(request, env, {
        waitUntil: (promise) => pending.push(promise),
      });
      await response.text();
      let released = false;
      const lifetime = Promise.all(pending).then(() => {
        released = true;
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(state.sent).toBe(1);
      expect(released).toBe(false);
      state.delivery.resolve();
      await lifetime;
      expect(released).toBe(true);
    },
  );
});

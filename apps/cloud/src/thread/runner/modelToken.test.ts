import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isModelToken, modelToken, threadOfModelToken } from "./modelToken.ts";

const grant = {
  threadId: ThreadId.make("thread-a"),
  runId: RunId.make("run-1"),
  provider: "anthropic" as const,
  pool: "user_1:personal",
  requester: "user_1",
};

describe("model tokens", () => {
  it.effect("name their thread and match only their own grant", () =>
    Effect.gen(function* () {
      const token = yield* modelToken("lease-a", grant);
      expect(threadOfModelToken(token)).toBe("thread-a");
      expect(yield* isModelToken(token, "lease-a", grant)).toBe(true);
      // Another thread, run, provider, pool, requester or machine lease.
      for (const [lease, other] of [
        ["lease-a", { ...grant, threadId: ThreadId.make("thread-b") }],
        ["lease-a", { ...grant, runId: RunId.make("run-2") }],
        ["lease-a", { ...grant, provider: "openai" as const }],
        ["lease-a", { ...grant, pool: "user_1:work" }],
        ["lease-a", { ...grant, requester: "user_2" }],
        ["lease-b", grant],
      ] as const) {
        expect(yield* isModelToken(token, lease, other)).toBe(false);
      }
    }),
  );

  it("reads no thread from anything else", () => {
    for (const token of ["sk-ant-123", "sbm1.x", "sbm2.dGhyZWFk.mac", "sbm1.!!!.mac", ""]) {
      expect(threadOfModelToken(token)).toBeNull();
    }
  });
});

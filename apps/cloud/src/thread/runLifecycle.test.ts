import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { providerThreadFor } from "./runLifecycle.ts";
import type { DecisionContext } from "./threadEvents.ts";

const ctx = { now: "2026-10-14T18:00:00.000Z" } as unknown as DecisionContext;
const stored = {
  id: "provider-thread:t1",
  driver: "claudeAgent",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  nativeThreadRef: { driver: "claudeAgent", nativeId: "claude-session-1", strength: "strong" },
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  ownerNodeId: null,
  createdAt: "2026-10-14T17:00:00.000Z",
} as unknown as OrchestrationV2ProviderThread;
const projection = {
  thread: { id: "t1" },
  providerThreads: [stored],
} as unknown as OrchestrationV2ThreadProjection;
const runOn = (instance: string) =>
  ({ ordinal: 2, providerInstanceId: ProviderInstanceId.make(instance) }) as OrchestrationV2Run;

describe("providerThreadFor", () => {
  it("keeps a session stored on the harness's own instance for a run on its pool's", () => {
    const next = providerThreadFor(projection, runOn("claude_hub"), "active", ctx);
    expect(next.nativeThreadRef?.nativeId).toBe("claude-session-1");
    // From now on the record is on the run's instance.
    expect(next.providerInstanceId).toBe("claude_hub");
  });

  it("starts over when the thread really moved to another harness", () => {
    const next = providerThreadFor(projection, runOn("codex_hub"), "active", ctx);
    expect(next.nativeThreadRef).toBeNull();
    expect(next.firstRunOrdinal).toBe(2);
    expect(next.id).not.toBe(stored.id);
  });

  it("refuses a native reference from another driver even when the instance id matches", () => {
    const mismatched = {
      ...stored,
      nativeThreadRef: { ...stored.nativeThreadRef!, driver: "codex" },
    };
    const next = providerThreadFor(
      { ...projection, providerThreads: [mismatched as OrchestrationV2ProviderThread] },
      runOn("claude_hub"),
      "active",
      ctx,
    );
    expect(next.nativeThreadRef).toBeNull();
    expect(next.id).not.toBe(stored.id);
  });
});

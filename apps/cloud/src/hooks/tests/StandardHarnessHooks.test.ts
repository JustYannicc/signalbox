import { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createStandardHarnessHookCallback } from "../StandardHarnessHooks.ts";
import type { HarnessHookRequest } from "../HarnessHooks.ts";
import type { ThreadHarnessActiveAttempt } from "../ThreadHarnessHooks.ts";

const threadId = ThreadId.make("thread:standard-hooks");
const attempt: ThreadHarnessActiveAttempt = {
  threadId,
  runId: RunId.make("run:standard-hooks"),
  attemptId: RunAttemptId.make("attempt:standard-hooks"),
  generation: 4,
};
const request = (event: HarnessHookRequest["event"]): HarnessHookRequest => ({
  harness: "claude-code",
  event,
  sessionId: "official-session",
  payload: { hook_event_name: event },
});

function fixture(
  active: ThreadHarnessActiveAttempt | null = attempt,
  status = async (effects: string[]) => {
    effects.push("status");
  },
) {
  const effects: string[] = [];
  const controller = new AbortController();
  const callback = createStandardHarnessHookCallback(
    { threadId, activeAttempt: () => active },
    {
      thread: { ensureTurnStatus: () => status(effects) },
      gateway: {
        async beforeToolUse() {
          effects.push("before");
        },
        async afterToolUse() {
          effects.push("after");
        },
      },
      automations: {
        async turnSettled() {
          effects.push("settled");
        },
      },
    },
  );
  return {
    effects,
    controller,
    invoke: (event: HarnessHookRequest["event"]) =>
      callback(request(event), { signal: controller.signal }),
  };
}

describe("standard hook dispatch guards", () => {
  it("permits SessionStart without a turn and rejects every run-scoped event before effects", async () => {
    const test = fixture(null);
    await expect(test.invoke("session-start")).resolves.toEqual({});
    for (const event of ["pre-tool-use", "post-tool-use", "stop"] as const) {
      await expect(test.invoke(event)).rejects.toThrow("active thread attempt");
    }
    expect(test.effects).toEqual([]);
  });

  it("rejects another thread's active attempt before effects", async () => {
    const test = fixture({ ...attempt, threadId: ThreadId.make("thread:foreign") });
    await expect(test.invoke("stop")).rejects.toThrow("belongs to another thread");
    expect(test.effects).toEqual([]);
  });

  it("publishes settlement after a failed status write while preserving its error", async () => {
    const status = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const test = fixture(attempt, async () => {
      started.resolve();
      await status.promise;
    });
    const pending = test.invoke("stop");
    await started.promise;
    expect(test.effects).toEqual([]);
    status.reject(new Error("status unavailable"));
    await expect(pending).rejects.toThrow("status unavailable");
    expect(test.effects).toEqual(["settled"]);
  });

  it("checks cancellation between a completed status write and publishing the settled event", async () => {
    const test = fixture(attempt, async () => {
      test.controller.abort(new Error("hook cancelled"));
    });
    await expect(test.invoke("stop")).rejects.toThrow("hook cancelled");
    expect(test.effects).toEqual([]);
  });
});

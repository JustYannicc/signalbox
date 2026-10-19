import { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HarnessHookRequest } from "../HarnessHooks.ts";
import {
  createThreadHarnessHookCallback,
  type ThreadHarnessActiveAttempt,
  type ThreadHarnessHookContext,
} from "../ThreadHarnessHooks.ts";

const threadId = ThreadId.make("thread:hook-owner");
const attempt = {
  threadId,
  runId: RunId.make("run:host-bound"),
  attemptId: RunAttemptId.make("attempt:host-bound"),
  generation: 8,
} as const;

const request: HarnessHookRequest = {
  harness: "claude-code",
  event: "pre-tool-use",
  sessionId: "session:untrusted-as-authority",
  turnId: "turn:official-input",
  toolCallId: "tool:official-input",
  payload: {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    future_field: { keep: true },
  },
};

describe("Thread harness hook callback", () => {
  it("binds the live attempt from the host closure and preserves official input and result", async () => {
    let hostAttempt: ThreadHarnessActiveAttempt = attempt;
    let received: ThreadHarnessHookContext | undefined;
    const result = { capabilityResult: { preserved: true } } as const;
    const signal = new AbortController().signal;
    const callback = createThreadHarnessHookCallback(
      { threadId, activeAttempt: () => hostAttempt },
      {
        invoke: async (context) => {
          received = context;
          return result;
        },
      },
    );

    expect(await callback(request, { signal })).toBe(result);
    expect(received).toEqual({
      authority: { threadId, activeAttempt: attempt },
      request,
      signal,
    });

    hostAttempt = { ...attempt, runId: RunId.make("run:next"), generation: 9 };
    await callback({ ...request, sessionId: "another-session" }, { signal });
    expect(received?.authority.activeAttempt).toEqual(hostAttempt);
    expect(received?.request.sessionId).toBe("another-session");
  });

  it("does not derive run authority from a session identifier when no attempt is active", async () => {
    let received: ThreadHarnessHookContext | undefined;
    const callback = createThreadHarnessHookCallback(
      { threadId, activeAttempt: () => null },
      {
        invoke: async (context) => {
          received = context;
          return {};
        },
      },
    );

    await callback(request, { signal: new AbortController().signal });

    expect(received?.authority).toEqual({ threadId, activeAttempt: null });
    expect(received?.request.sessionId).toBe(request.sessionId);
  });

  it("rejects an attempt from another thread before calling the supplied capability", async () => {
    const callback = createThreadHarnessHookCallback(
      {
        threadId,
        activeAttempt: () => ({
          ...attempt,
          threadId: ThreadId.make("thread:other"),
        }),
      },
      {
        invoke: async () => {
          throw new Error("An attempt from another thread must not reach the capability.");
        },
      },
    );

    await expect(callback(request, { signal: new AbortController().signal })).rejects.toThrow(
      "belongs to another thread",
    );
  });

  it("checks cancellation before resolving host authority", async () => {
    const controller = new AbortController();
    const reason = new Error("hook cancelled");
    controller.abort(reason);
    const callback = createThreadHarnessHookCallback(
      {
        threadId,
        activeAttempt: () => {
          throw new Error("Cancelled hooks must not inspect active authority.");
        },
      },
      { invoke: async () => ({}) },
    );

    await expect(callback(request, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("checks cancellation again after resolving host authority", async () => {
    const controller = new AbortController();
    const reason = new Error("hook cancelled while reading host authority");
    const callback = createThreadHarnessHookCallback(
      {
        threadId,
        activeAttempt: () => {
          controller.abort(reason);
          return attempt;
        },
      },
      {
        invoke: async () => {
          throw new Error("Cancelled hooks must not reach the capability.");
        },
      },
    );

    await expect(callback(request, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("passes cancellation to the capability and does not return a late result", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("hook cancelled while RPC was pending");
    let receivedSignal: AbortSignal | undefined;
    const callback = createThreadHarnessHookCallback(
      { threadId, activeAttempt: () => attempt },
      {
        invoke: async ({ signal }) => {
          receivedSignal = signal;
          started.resolve();
          await finish.promise;
          return { continue: true };
        },
      },
    );

    const pending = callback(request, { signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    finish.resolve();

    expect(receivedSignal).toBe(controller.signal);
    await expect(pending).rejects.toBe(reason);
  });
});

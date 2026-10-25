import { it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect } from "vite-plus/test";

import { assessTab } from "./ServerBrowserTabCleanup.ts";

const thread = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): Parameters<typeof assessTab>[0]["thread"] =>
  ({
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    status: "idle",
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  }) as unknown as Parameters<typeof assessTab>[0]["thread"];

const state = {
  agentOwned: true,
  humanControlled: false,
  visible: false,
  activeOperation: false,
  loading: false,
  pendingInteraction: false,
  recording: false,
  usedAt: 0,
  now: 31 * 60 * 1000,
  thread: thread(),
};

it("cleans settled and archived threads, while preserving active owners and operations", () => {
  expect(
    assessTab({
      ...state,
      thread: thread({ settledOverride: "settled" }),
      now: 1,
    }).cleanupReason,
  ).toBe("settled");
  expect(
    assessTab({
      ...state,
      thread: thread({ archivedAt: DateTime.makeUnsafe("2026-10-17T00:00:00.000Z") }),
      now: 1,
    }).cleanupReason,
  ).toBe("archived");
  expect(assessTab({ ...state, thread: thread({ status: "running" }) }).blockedBy).toBe(
    "active-thread",
  );
  expect(assessTab({ ...state, activeOperation: true }).blockedBy).toBe("active-operation");
  expect(assessTab({ ...state, humanControlled: true }).blockedBy).toBe("human-controlled");
  expect(assessTab({ ...state, visible: true }).blockedBy).toBe("visible");
  expect(assessTab({ ...state, loading: true }).blockedBy).toBe("loading");
  expect(assessTab({ ...state, pendingInteraction: true }).blockedBy).toBe("pending-interaction");
  expect(assessTab({ ...state, recording: true }).blockedBy).toBe("recording");
});

it("cleans an inactive tab only after 30 minutes and fails closed on unreadable lifecycle state", () => {
  expect(assessTab({ ...state, now: 30 * 60 * 1000 }).blockedBy).toBe("idle-window");
  expect(assessTab({ ...state, now: 30 * 60 * 1000 + 1 }).cleanupReason).toBe("idle");
  expect(assessTab({ ...state, thread: undefined }).blockedBy).toBe("lifecycle-unavailable");
});

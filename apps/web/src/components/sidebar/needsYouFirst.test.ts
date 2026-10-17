import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { sortThreadsNeedsYouFirst, threadNeedsYou } from "./needsYouFirst";

const thread = (id: string, createdAt: string, overrides = {}) =>
  makeThreadFixture({ id: ThreadId.make(id), createdAt, ...overrides });

const failedRun = {
  runId: "run-1" as never,
  status: "failed" as const,
  requestedAt: "2026-10-17T09:00:00.000Z",
  startedAt: "2026-10-17T09:00:00.000Z",
  completedAt: "2026-10-17T09:05:00.000Z",
  assistantMessageId: null,
};

describe("threadNeedsYou", () => {
  it("counts questions, approvals and a subagent's request", () => {
    expect(
      threadNeedsYou(thread("a", "2026-10-17T09:00:00.000Z", { hasPendingUserInput: true })),
    ).toBe(true);
    expect(
      threadNeedsYou(thread("b", "2026-10-17T09:00:00.000Z", { hasPendingApprovals: true })),
    ).toBe(true);
    expect(
      threadNeedsYou(
        thread("c", "2026-10-17T09:00:00.000Z", { pendingSubagentRequest: "approval" }),
      ),
    ).toBe(true);
  });

  it("counts a failure until the person has seen it", () => {
    const unseen = { latestRun: failedRun, lastVisitedAt: "2026-10-17T09:01:00.000Z" };
    const seen = { latestRun: failedRun, lastVisitedAt: "2026-10-17T09:06:00.000Z" };
    expect(threadNeedsYou(thread("a", "2026-10-17T09:00:00.000Z", unseen))).toBe(true);
    expect(threadNeedsYou(thread("b", "2026-10-17T09:00:00.000Z", seen))).toBe(false);
    // An automation's thread nobody has opened still waits on someone.
    const neverOpened = { latestRun: failedRun, lastVisitedAt: null };
    expect(threadNeedsYou(thread("c", "2026-10-17T09:00:00.000Z", neverOpened))).toBe(true);
  });

  it("doesn't count a thread that is only working or done", () => {
    expect(threadNeedsYou(thread("a", "2026-10-17T09:00:00.000Z"))).toBe(false);
  });
});

describe("sortThreadsNeedsYouFirst", () => {
  it("lifts waiting threads above newer ones and keeps each group's order", () => {
    const threads = [
      thread("old-question", "2026-10-17T08:00:00.000Z", { hasPendingUserInput: true }),
      thread("newest", "2026-10-17T12:00:00.000Z"),
      thread("old-approval", "2026-10-17T07:00:00.000Z", { hasPendingApprovals: true }),
      thread("newer", "2026-10-17T11:00:00.000Z"),
    ];
    expect(sortThreadsNeedsYouFirst(threads, "created_at").map((t) => t.id)).toEqual([
      "old-question",
      "old-approval",
      "newest",
      "newer",
    ]);
  });
});

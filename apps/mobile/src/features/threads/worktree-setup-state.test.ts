import { RunId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { resolveVisibleWorktreeSetup } from "@t3tools/client-runtime/worktree-setup";
import { describe, expect, it } from "vite-plus/test";
import { resolveComposerStop, resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

const threadId = ThreadId.make("setup-thread");
const running: WorktreeSetupSnapshot = {
  threadId,
  sequence: 1,
  phase: "running",
  startedAt: "2026-09-17T00:00:00.000Z",
  endedAt: null,
  branch: "feature",
  baseRef: "main",
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: null,
};

describe("mobile worktree setup handoff", () => {
  it("keeps the setup identity after its card retires so the working header can take over", () => {
    const done = { ...running, phase: "done" as const, sequence: 2 };
    const held = resolveWorktreeSetupSnapshot(threadId, done, running);
    expect(held).toBe(done);
    expect(
      resolveVisibleWorktreeSetup({
        live: held,
        recorded: null,
        turnStarted: false,
        followUpSent: false,
      }),
    ).toBe(done);
    expect(
      resolveVisibleWorktreeSetup({
        live: held,
        recorded: null,
        turnStarted: true,
        followUpSent: false,
      }),
    ).toBeNull();
    expect(resolveWorktreeSetupSnapshot(threadId, undefined, held)).toBe(done);
  });

  it.each(["failed", "cancelled"] as const)(
    "retains %s details after the stream closes",
    (phase) => {
      const settled = { ...running, phase, sequence: 3 };
      const held = resolveWorktreeSetupSnapshot(threadId, settled, running);
      expect(resolveWorktreeSetupSnapshot(threadId, null, held)).toBe(settled);
      expect(resolveWorktreeSetupSnapshot(threadId, running, held)).toBe(settled);
      expect(
        resolveVisibleWorktreeSetup({
          live: held,
          recorded: null,
          turnStarted: false,
          followUpSent: false,
        }),
      ).toBe(settled);
      expect(
        resolveVisibleWorktreeSetup({
          live: held,
          recorded: null,
          turnStarted: false,
          followUpSent: true,
        }),
      ).toBeNull();
    },
  );

  it("does not carry a previous thread's progress across navigation", () => {
    const otherId = ThreadId.make("other-thread");
    expect(resolveWorktreeSetupSnapshot(otherId, running, running)).toBeNull();
    const other = { ...running, threadId: otherId };
    expect(resolveWorktreeSetupSnapshot(otherId, other, running)).toBe(other);
  });
});

describe("mobile worktree setup retries", () => {
  const cloud: WorktreeSetupSnapshot = {
    ...running,
    runId: RunId.make("setup-run"),
    preparationGeneration: 1,
    turnStarted: false,
    cancellationRequested: false,
  };

  it("lets the retried attempt replace the held ending, and not the other way round", () => {
    const cancelled = { ...cloud, phase: "cancelled" as const, sequence: 2 };
    const retried = { ...cloud, preparationGeneration: 2, sequence: 3 };
    expect(resolveWorktreeSetupSnapshot(threadId, retried, cancelled)).toBe(retried);
    expect(resolveWorktreeSetupSnapshot(threadId, cancelled, retried)).toBe(retried);
  });
});

describe("mobile composer stop during setup", () => {
  it("offers no stop before a snapshot names the attempt", () => {
    expect(
      resolveComposerStop({ awaitingSetup: true, setupCancel: null, interruptible: true }),
    ).toBeNull();
  });

  it("cancels setup rather than interrupting the run before the handoff", () => {
    expect(
      resolveComposerStop({ awaitingSetup: true, setupCancel: "available", interruptible: true }),
    ).toBe("cancel-setup");
  });

  it("hides the stop while a requested cancel is pending", () => {
    expect(
      resolveComposerStop({ awaitingSetup: true, setupCancel: "pending", interruptible: false }),
    ).toBeNull();
  });

  it("interrupts the run once setup no longer holds the thread", () => {
    expect(
      resolveComposerStop({ awaitingSetup: false, setupCancel: null, interruptible: true }),
    ).toBe("interrupt");
    expect(
      resolveComposerStop({ awaitingSetup: false, setupCancel: null, interruptible: false }),
    ).toBeNull();
  });
});

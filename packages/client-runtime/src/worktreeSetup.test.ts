import {
  RunId,
  ThreadId,
  WorktreeSetupError,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  grantedWorktreeSetupActions,
  isThreadPreparation,
  pendingWorktreeSetupAction,
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupActions,
  runAwaitsSetup,
  worktreeSetupCancelOutcome,
  worktreeSetupAttemptKey,
  worktreeSetupAgentStarted,
  worktreeSetupCancelInput,
  worktreeSetupRetryTarget,
} from "@t3tools/client-runtime/worktree-setup";

const snapshot: WorktreeSetupSnapshot = {
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
  preparationGeneration: 3,
  phase: "running",
  startedAt: "2026-10-17T12:00:00.000Z",
  endedAt: null,
  branch: null,
  baseRef: null,
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: null,
  sequence: 10,
  turnStarted: false,
  cancellationRequested: false,
};

describe("worktree preparation actions", () => {
  it("addresses the displayed attempt, keeping a self-hosted snapshot compatible", () => {
    expect(worktreeSetupCancelInput(snapshot)).toEqual({
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      preparationGeneration: 3,
    });
    const { runId: _runId, preparationGeneration: _generation, ...legacy } = snapshot;
    expect(worktreeSetupCancelInput(legacy)).toEqual({ threadId: snapshot.threadId });
    expect(worktreeSetupCancelInput({ ...legacy, runId: snapshot.runId })).toBeNull();
    expect(worktreeSetupCancelInput({ ...legacy, preparationGeneration: 3 })).toBeNull();
  });

  it("blocks repeated cancellation and cancellation at the durable provider handoff", () => {
    expect(worktreeSetupCancelInput({ ...snapshot, cancellationRequested: true })).toBeNull();
    expect(worktreeSetupAgentStarted({ ...snapshot, turnStarted: true })).toBe(true);
    expect(worktreeSetupCancelInput({ ...snapshot, turnStarted: true })).toBeNull();
    expect(worktreeSetupCancelInput({ ...snapshot, phase: "cancelled" })).toBeNull();
  });

  it("keeps a cancelled or failed cloud attempt recoverable, with its own retry guard", () => {
    for (const phase of ["failed", "cancelled"] as const) {
      const terminal = { ...snapshot, phase };
      expect(worktreeSetupRetryTarget(terminal)).toEqual({
        threadId: snapshot.threadId,
        runId: snapshot.runId,
        preparationGeneration: 3,
      });
      expect(
        resolveVisibleWorktreeSetup({
          live: null,
          recorded: terminal,
          turnStarted: false,
          followUpSent: false,
        }),
      ).toBe(terminal);
      expect(
        resolveVisibleWorktreeSetup({
          live: terminal,
          recorded: null,
          turnStarted: false,
          followUpSent: true,
        }),
      ).toBe(terminal);
      expect(worktreeSetupRetryTarget({ ...terminal, turnStarted: true })).toBeNull();
    }
    expect(worktreeSetupRetryTarget(snapshot)).toBeNull();
  });

  it("prefers the newer attempt's monotonic snapshot over retained terminal history", () => {
    const previous = { ...snapshot, phase: "cancelled" as const };
    const retry = { ...snapshot, preparationGeneration: 4, sequence: 11 };
    expect(
      resolveVisibleWorktreeSetup({
        live: retry,
        recorded: previous,
        turnStarted: false,
        followUpSent: false,
      }),
    ).toBe(retry);
    expect(worktreeSetupCancelInput(retry)?.preparationGeneration).toBe(4);
    expect(worktreeSetupRetryTarget(retry)).toBeNull();
  });
});

const threadId = snapshot.threadId;
const runId = snapshot.runId;

describe("resolveWorktreeSetupActions", () => {
  it("cancels the exact cloud attempt the card shows", () => {
    expect(resolveWorktreeSetupActions(snapshot, null)).toMatchObject({
      cancel: "available",
      cancelInput: { threadId, runId, preparationGeneration: 3 },
      retry: null,
    });
  });

  it("keeps a requested stop pending until the server ends the attempt", () => {
    const requested = resolveWorktreeSetupActions(
      { ...snapshot, cancellationRequested: true },
      null,
    );
    expect(requested).toMatchObject({ cancel: "pending", cancelInput: null });

    const sent = resolveWorktreeSetupActions(snapshot, {
      kind: "cancel",
      attempt: worktreeSetupAttemptKey(snapshot),
    });
    expect(sent).toMatchObject({ cancel: "pending", cancelInput: null });
  });

  it("drops the stop once the agent has taken over", () => {
    expect(resolveWorktreeSetupActions({ ...snapshot, turnStarted: true }, null)).toMatchObject({
      cancel: null,
      retry: null,
    });
  });

  it("offers retry from a failed or cancelled cloud attempt", () => {
    for (const phase of ["failed", "cancelled"] as const) {
      expect(
        resolveWorktreeSetupActions(
          { ...snapshot, phase, endedAt: "2026-10-17T00:01:00.000Z" },
          null,
        ),
      ).toMatchObject({
        cancel: null,
        retry: "available",
        retryTarget: { threadId, runId, preparationGeneration: 3 },
      });
    }
  });

  it("does not carry a pending retry over to the attempt it started", () => {
    const cancelled = { ...snapshot, phase: "cancelled" as const };
    const pending = { kind: "retry" as const, attempt: worktreeSetupAttemptKey(cancelled) };
    expect(resolveWorktreeSetupActions(cancelled, pending).retry).toBe("pending");

    const next = { ...snapshot, preparationGeneration: 4, sequence: 11 };
    expect(resolveWorktreeSetupActions(next, pending)).toMatchObject({
      cancel: "available",
      cancelInput: { preparationGeneration: 4 },
    });
  });

  it("keeps self-hosted cancel by thread and leaves retry to the run marker", () => {
    const {
      runId: _runId,
      preparationGeneration: _generation,
      turnStarted: _turnStarted,
      cancellationRequested: _requested,
      ...selfHosted
    } = snapshot;
    expect(resolveWorktreeSetupActions(selfHosted, null)).toMatchObject({
      cancel: "available",
      cancelInput: { threadId },
    });
    expect(resolveWorktreeSetupActions({ ...selfHosted, phase: "failed" }, null).retry).toBeNull();
  });
});

describe("worktree preparation pending state", () => {
  it("keeps cancellation pending across progress updates without blocking a newer attempt", () => {
    const pending = { kind: "cancel" as const, attempt: worktreeSetupAttemptKey(snapshot) };
    const progress = { ...snapshot, sequence: snapshot.sequence + 1 };
    expect(resolveWorktreeSetupActions(progress, pending)).toMatchObject({
      cancel: "pending",
      cancelInput: null,
    });
    const retry = { ...snapshot, preparationGeneration: 4, sequence: 12 };
    expect(resolveWorktreeSetupActions(retry, pending)).toMatchObject({
      cancel: "available",
      cancelInput: { preparationGeneration: 4 },
    });
    const cancelled = { ...snapshot, phase: "cancelled" as const };
    expect(resolveWorktreeSetupActions(cancelled, pending)).toMatchObject({
      cancel: null,
      retry: "available",
    });
    expect(resolveWorktreeSetupActions({ ...snapshot, turnStarted: true }, pending)).toMatchObject({
      cancel: null,
      retry: null,
    });
  });

  it("uses self-hosted preparation start times to distinguish pending attempts", () => {
    const { runId: _runId, preparationGeneration: _generation, ...legacy } = snapshot;
    const pending = { kind: "cancel" as const, attempt: worktreeSetupAttemptKey(legacy) };
    expect(resolveWorktreeSetupActions(legacy, pending).cancel).toBe("pending");
    expect(
      resolveWorktreeSetupActions({ ...legacy, startedAt: "2026-10-17T13:00:00.000Z" }, pending)
        .cancel,
    ).toBe("available");
  });
});

describe("setup on a device that did not send the message", () => {
  it("tells a cloud thread's preparation from a self-hosted worktree setup", () => {
    const { runId: _runId, preparationGeneration: _generation, ...legacy } = snapshot;
    expect(isThreadPreparation(snapshot)).toBe(true);
    expect(isThreadPreparation(legacy)).toBe(false);
  });

  it("recognises cloud setup from the run alone, and not self-hosted starting runs", () => {
    const cloudStarting = { status: "starting", startedAt: null };
    expect(runAwaitsSetup(cloudStarting, true)).toBe(true);
    expect(runAwaitsSetup(cloudStarting, false)).toBe(false);
    expect(runAwaitsSetup({ status: "starting", startedAt: snapshot.startedAt }, true)).toBe(false);
    expect(runAwaitsSetup({ status: "preparing", startedAt: null }, false)).toBe(true);
    expect(runAwaitsSetup(null, true)).toBe(false);
  });

  it("hides controls the viewer has no grant for, keeping someone else's stop visible", () => {
    const failed = resolveWorktreeSetupActions({ ...snapshot, phase: "failed" }, null);
    expect(grantedWorktreeSetupActions(failed, { cancel: true, retry: false })).toEqual({
      cancel: null,
      retry: null,
    });
    expect(grantedWorktreeSetupActions(failed, { cancel: false, retry: true })).toEqual({
      cancel: null,
      retry: "available",
    });
    expect(
      grantedWorktreeSetupActions(
        { cancel: "pending", retry: null },
        { cancel: false, retry: false },
      ),
    ).toEqual({ cancel: "pending", retry: null });
  });
});

describe("cancel outcome", () => {
  it("counts only a confirmed stop as stopped, so Work locally never resends early", () => {
    expect(worktreeSetupCancelOutcome(AsyncResult.success({ cancelled: true }))).toBe("stopped");
    expect(worktreeSetupCancelOutcome(AsyncResult.success({ cancelled: false }))).toBe(
      "not-stopped",
    );
    // The server's bounded wait timing out, or a refusal, is a typed error.
    expect(
      worktreeSetupCancelOutcome(
        AsyncResult.failure(Cause.fail(new WorktreeSetupError({ message: "Still stopping" }))),
      ),
    ).toBe("not-stopped");
    expect(worktreeSetupCancelOutcome(AsyncResult.failure(Cause.die(new Error("socket"))))).toBe(
      "unknown",
    );
    expect(worktreeSetupCancelOutcome(AsyncResult.failure(Cause.interrupt()))).toBe("unknown");
  });

  it("keeps a sent request pending until a snapshot after its response says otherwise", () => {
    const action = { kind: "cancel", attempt: "attempt-1" } as const;
    const sent = { action, sentWith: snapshot, settled: false };
    expect(pendingWorktreeSetupAction(sent, snapshot)).toBe(action);
    const settled = { ...sent, settled: true };
    expect(pendingWorktreeSetupAction(settled, snapshot)).toBe(action);
    // A progress update, the terminal state or a reconnect's replay is a new snapshot.
    expect(pendingWorktreeSetupAction(settled, { ...snapshot })).toBeNull();
    expect(pendingWorktreeSetupAction(null, snapshot)).toBeNull();
  });
});

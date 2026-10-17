import { RunId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupActions,
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

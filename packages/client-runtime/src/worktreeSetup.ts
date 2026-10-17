import {
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  type WorktreeSetupCancelInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeWorktreeSetupSnapshot = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

export function findRecordedWorktreeSetup(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  threadId: ThreadId,
): WorktreeSetupSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== WORKTREE_SETUP_ACTIVITY_KIND) continue;
    const decoded = decodeWorktreeSetupSnapshot(activity.payload);
    if (Option.isSome(decoded) && decoded.value.threadId === threadId) return decoded.value;
  }
  return null;
}

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent && snapshot.preparationGeneration === undefined) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return (
    snapshot.turnStarted === true ||
    snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done")
  );
}

export function worktreeSetupCancelInput(
  snapshot: WorktreeSetupSnapshot,
): WorktreeSetupCancelInput | null {
  if (
    snapshot.phase !== "running" ||
    worktreeSetupAgentStarted(snapshot) ||
    snapshot.cancellationRequested === true
  )
    return null;
  if (snapshot.runId === undefined && snapshot.preparationGeneration === undefined)
    return { threadId: snapshot.threadId };
  if (snapshot.runId === undefined || snapshot.preparationGeneration === undefined) return null;
  return {
    threadId: snapshot.threadId,
    runId: snapshot.runId,
    preparationGeneration: snapshot.preparationGeneration,
  };
}

export function worktreeSetupRetryTarget(snapshot: WorktreeSetupSnapshot) {
  if (
    (snapshot.phase !== "failed" && snapshot.phase !== "cancelled") ||
    worktreeSetupAgentStarted(snapshot) ||
    snapshot.runId === undefined ||
    snapshot.preparationGeneration === undefined
  )
    return null;
  return {
    threadId: snapshot.threadId,
    runId: snapshot.runId,
    preparationGeneration: snapshot.preparationGeneration,
  };
}

export type WorktreeSetupActionStatus = "available" | "pending";

/** A cancel or retry the client sent for one preparation attempt. */
export interface WorktreeSetupPendingAction {
  readonly kind: "cancel" | "retry";
  readonly attempt: string;
}

// A retry starts a new attempt, so a request sent for an old one never marks
// the new one pending. Self-hosted snapshots have no run or generation; their
// start time still tells attempts apart.
export function worktreeSetupAttemptKey(snapshot: WorktreeSetupSnapshot): string {
  return JSON.stringify([
    snapshot.threadId,
    snapshot.runId ?? null,
    snapshot.preparationGeneration ?? null,
    snapshot.startedAt,
  ]);
}

/**
 * What the setup card may offer for this snapshot. The server decides the
 * outcome: a requested stop stays pending until the snapshot itself ends.
 */
export function resolveWorktreeSetupActions(
  snapshot: WorktreeSetupSnapshot,
  pending: WorktreeSetupPendingAction | null,
) {
  const pendingKind = pending?.attempt === worktreeSetupAttemptKey(snapshot) ? pending.kind : null;
  const cancelInput = worktreeSetupCancelInput(snapshot);
  const retryTarget = worktreeSetupRetryTarget(snapshot);
  const stopping =
    snapshot.phase === "running" &&
    !worktreeSetupAgentStarted(snapshot) &&
    (snapshot.cancellationRequested === true || pendingKind === "cancel");
  const cancel: WorktreeSetupActionStatus | null = stopping
    ? "pending"
    : cancelInput
      ? "available"
      : null;
  const retry: WorktreeSetupActionStatus | null = retryTarget
    ? pendingKind === "retry"
      ? "pending"
      : "available"
    : null;
  return { cancel, cancelInput: stopping ? null : cancelInput, retry, retryTarget };
}

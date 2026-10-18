import {
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  type WorktreeSetupCancelInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AtomCommandResult } from "./state/runtime.ts";

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

/**
 * Cloud prepares every run's thread, worktree or not, and numbers each attempt;
 * a self-hosted snapshot is always a worktree's setup.
 */
export function isThreadPreparation(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.preparationGeneration !== undefined;
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

/**
 * Whether the latest run may be setting up before its first snapshot arrives.
 * A self-hosted run says `preparing`. Cloud keeps a run `starting`, with no
 * start time, until the agent handoff; elsewhere `starting` is not setup.
 */
export function runAwaitsSetup(
  run: { readonly status: string; readonly startedAt?: string | null } | null | undefined,
  durableSetup: boolean,
): boolean {
  if (!run) return false;
  if (run.status === "preparing") return true;
  return durableSetup && run.status === "starting" && run.startedAt == null;
}

export type WorktreeSetupCancelOutcome = "stopped" | "not-stopped" | "unknown";

/**
 * Reads a cancel response literally: `cancelled: true` means the attempt has
 * stopped. A typed error (refused, or the stop did not land in time) means it
 * has not. Anything else, like a dropped connection, leaves the outcome
 * unknown until the next snapshot says.
 */
export function worktreeSetupCancelOutcome(
  result: AtomCommandResult<{ readonly cancelled: boolean }, unknown>,
): WorktreeSetupCancelOutcome {
  if (result._tag === "Success") return result.value.cancelled ? "stopped" : "not-stopped";
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  return tag === "WorktreeSetupError" || tag === "EnvironmentAuthorizationError"
    ? "not-stopped"
    : "unknown";
}

/**
 * Hides a control the viewer lacks the grant for. A pending stop or retry
 * someone else requested still reads as pending.
 */
export function grantedWorktreeSetupActions(
  state: {
    readonly cancel: WorktreeSetupActionStatus | null;
    readonly retry: WorktreeSetupActionStatus | null;
  } | null,
  grants: { readonly cancel: boolean; readonly retry: boolean },
): {
  readonly cancel: WorktreeSetupActionStatus | null;
  readonly retry: WorktreeSetupActionStatus | null;
} {
  return {
    cancel: state?.cancel === "available" && !grants.cancel ? null : (state?.cancel ?? null),
    retry: state?.retry === "available" && !grants.retry ? null : (state?.retry ?? null),
  };
}

/** A cancel or retry sent for one attempt, and the snapshot it was sent against. */
export interface WorktreeSetupPendingRequest {
  readonly action: WorktreeSetupPendingAction;
  readonly sentWith: WorktreeSetupSnapshot;
  readonly settled: boolean;
}

/**
 * The request still waiting on the server. Once its response is in, the next
 * snapshot (a progress update, the terminal state or a reconnect's replay)
 * becomes the truth: it either carries the stop or the new attempt, or the
 * request did not land.
 */
export function pendingWorktreeSetupAction(
  request: WorktreeSetupPendingRequest | null,
  snapshot: WorktreeSetupSnapshot | null,
): WorktreeSetupPendingAction | null {
  if (!request) return null;
  return request.settled && request.sentWith !== snapshot ? null : request.action;
}

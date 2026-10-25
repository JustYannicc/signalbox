import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** A done-condition may only settle the exact idle thread state it observed. */
export function taskCompletionSnapshotIsStale(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "updatedAt" | "archivedAt" | "settledOverride">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
  readonly snapshotAt: DateTime.Utc;
}): boolean {
  return (
    DateTime.toEpochMillis(input.thread.updatedAt) > DateTime.toEpochMillis(input.snapshotAt) ||
    input.thread.archivedAt !== null ||
    input.thread.settledOverride === "settled" ||
    input.runs.some((run) => run.status === "queued" || ACTIVE_RUN_STATUSES.has(run.status))
  );
}

/** The done-condition uses the existing settlement/archive fields as one state. */
export function archiveSettledTask(
  thread: OrchestrationV2AppThread,
  at: DateTime.Utc,
): OrchestrationV2AppThread {
  return {
    ...thread,
    archivedAt: at,
    settledOverride: "settled",
    settledAt: at,
    unsettledAt: null,
    updatedAt: at,
  };
}

/** Reopening changes lifecycle fields only; the transcript and work state stay intact. */
export function reopenArchivedTask(
  thread: OrchestrationV2AppThread,
  at: DateTime.Utc,
): OrchestrationV2AppThread {
  const wasSettled = thread.settledOverride === "settled" || thread.settledAt !== null;
  return {
    ...thread,
    archivedAt: null,
    ...(wasSettled
      ? {
          settledOverride: "active" as const,
          settledAt: null,
          unsettledAt: at,
        }
      : {}),
    updatedAt: at,
  };
}

/** A person replying reopens the thread and clears the old settlement override. */
export function reopenForUserMessage(
  thread: OrchestrationV2AppThread,
  at: DateTime.Utc,
): OrchestrationV2AppThread {
  const wasSettled = thread.settledOverride !== null || thread.settledAt !== null;
  return {
    ...thread,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: wasSettled ? at : (thread.unsettledAt ?? null),
    updatedAt: at,
  };
}

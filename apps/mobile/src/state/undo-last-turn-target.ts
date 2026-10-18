import { deriveRunContinuations } from "@t3tools/client-runtime/state/thread-execution";
import type {
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type Checkpoint = Projection["checkpoints"][number];

const SETTLED_RUN_STATUSES = new Set<Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export interface UndoLastTurnTarget {
  readonly userMessageId: MessageId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly scopeId: CheckpointScopeId;
  readonly checkpointId: CheckpointId;
  /** False when the turn's own checkpoint shows no file changes, so files need no decision. */
  readonly changedFiles: boolean;
}

/**
 * Undo rolls the thread back to the end of the newest turn before the last
 * one, or to the thread's baseline when the last turn is the first. Mirrors
 * the target rules `checkpoint.rollback` validates, so the button only shows
 * when the server will accept it.
 */
export function resolveUndoLastTurnTarget(projection: Projection): UndoLastTurnTarget | null {
  if (projection.runs.some((run) => !SETTLED_RUN_STATUSES.has(run.status))) return null;
  const last = projection.runs.reduce<Run | null>(
    (latest, run) =>
      run.status !== "rolled_back" && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (last === null) return null;
  const history = projection.runs.filter((run) => run.status !== "rolled_back");
  const continuations = deriveRunContinuations(history);
  const rootId = continuations.get(last.id)?.rootRunId;
  const root = history.find((run) => run.id === rootId);
  // A missing continuation ancestor leaves both the user row and undo boundary unknown.
  if (root === undefined || root.restartContinuationOfRunId !== undefined) return null;
  const target = checkpointBefore(projection, root.ordinal);
  if (target === null) return null;
  const changedFiles = history.some((run) => {
    if (continuations.get(run.id)?.rootRunId !== root.id) return false;
    const own = projection.checkpoints.find((checkpoint) => checkpoint.id === run.checkpointId);
    return own?.status !== "ready" || own.files.length > 0;
  });
  return {
    userMessageId: root.userMessageId,
    providerInstanceId: last.providerInstanceId,
    scopeId: target.scopeId,
    checkpointId: target.id,
    changedFiles,
  };
}

function checkpointBefore(projection: Projection, ordinal: number): Checkpoint | null {
  const runsByOrdinal = new Map(projection.runs.map((run) => [run.ordinal, run]));
  const rootScopeIds = new Set(
    projection.checkpointScopes
      .filter((scope) => scope.kind === "root_run")
      .map((scope) => scope.id),
  );
  const usable = (checkpoint: Checkpoint, run: Run) =>
    checkpoint.runId === run.id &&
    checkpoint.status === "ready" &&
    rootScopeIds.has(checkpoint.scopeId);
  for (let previous = ordinal - 1; previous >= 1; previous--) {
    const run = runsByOrdinal.get(previous);
    // Paged history can leave older runs out; without them the target is unknown.
    if (run === undefined) return null;
    if (run.status === "rolled_back") continue;
    return (
      projection.checkpoints.findLast(
        (checkpoint) => usable(checkpoint, run) && checkpoint.appRunOrdinal === run.ordinal,
      ) ?? null
    );
  }
  const first = runsByOrdinal.get(1);
  if (first === undefined) return null;
  return (
    projection.checkpoints.find(
      (checkpoint) =>
        usable(checkpoint, first) &&
        checkpoint.ordinalWithinScope === 0 &&
        checkpoint.appRunOrdinal === null,
    ) ?? null
  );
}

export function sameUndoLastTurnTarget(
  a: UndoLastTurnTarget | null,
  b: UndoLastTurnTarget | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.userMessageId === b.userMessageId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.scopeId === b.scopeId &&
    a.checkpointId === b.checkpointId &&
    a.changedFiles === b.changedFiles
  );
}

// signalbox: which folders a cloud thread's saved machine leaves out, and how each comes back (#490).
import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointSkippedFolder,
} from "@t3tools/contracts";

/**
 * The skipped folders from the thread's latest turn that recorded them, or null when no
 * turn did (not a cloud thread with machine state) or the latest left nothing out.
 * Returns the checkpoint's own array, so the value keeps its identity across projection updates.
 */
export function latestSkippedFolders(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
): ReadonlyArray<OrchestrationV2CheckpointSkippedFolder> | null {
  let latest: OrchestrationV2Checkpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.skipped === undefined) continue;
    // Ties and unnumbered checkpoints fall back to projection order: later wins.
    if (latest === null || (checkpoint.appRunOrdinal ?? 0) >= (latest.appRunOrdinal ?? 0)) {
      latest = checkpoint;
    }
  }
  const skipped = latest?.skipped;
  return skipped && skipped.length > 0 ? skipped : null;
}

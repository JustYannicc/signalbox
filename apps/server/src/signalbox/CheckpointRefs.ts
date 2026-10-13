import { CheckpointRef, type ThreadId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";

import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";

const SIGNALBOX_CHECKPOINT_REFS_PREFIX = "refs/signalbox/checkpoints";
// Everything Signalbox writes lives under refs/signalbox/ (V1 checkpoints and
// orchestration-v2's). The same path under refs/t3/ is T3 Code's, or ours from
// before the split: readable as a fallback, never deleted.
const SIGNALBOX_REFS = "refs/signalbox/";
const T3_REFS = "refs/t3/";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${SIGNALBOX_CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

const isSignalboxCheckpointRef = (checkpointRef: CheckpointRef): boolean =>
  checkpointRef.startsWith(SIGNALBOX_REFS);

const legacyT3CheckpointRef = (checkpointRef: CheckpointRef): CheckpointRef | undefined =>
  isSignalboxCheckpointRef(checkpointRef)
    ? CheckpointRef.make(`${T3_REFS}${checkpointRef.slice(SIGNALBOX_REFS.length)}`)
    : undefined;

const resolveReadCheckpointRef = (input: {
  readonly checkpoints: VcsCheckpointOps;
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}) =>
  Effect.gen(function* () {
    if (!isSignalboxCheckpointRef(input.checkpointRef)) return input.checkpointRef;

    if (
      yield* input.checkpoints.hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: input.checkpointRef,
      })
    ) {
      return input.checkpointRef;
    }

    const legacyRef = legacyT3CheckpointRef(input.checkpointRef);
    if (
      legacyRef &&
      (yield* input.checkpoints.hasCheckpointRef({ cwd: input.cwd, checkpointRef: legacyRef }))
    ) {
      return legacyRef;
    }
    return input.checkpointRef;
  });

/** Adds Signalbox's shared-repository checkpoint ownership rules at the VCS seam. */
export function withSignalboxCheckpointRefs(checkpoints: VcsCheckpointOps): VcsCheckpointOps {
  return {
    ...checkpoints,
    restoreCheckpoint: (input) =>
      resolveReadCheckpointRef({
        checkpoints,
        cwd: input.cwd,
        checkpointRef: input.checkpointRef,
      }).pipe(
        Effect.flatMap((checkpointRef) =>
          checkpoints.restoreCheckpoint({ ...input, checkpointRef }),
        ),
      ),
    diffCheckpoints: (input) =>
      Effect.all({
        fromCheckpointRef: resolveReadCheckpointRef({
          checkpoints,
          cwd: input.cwd,
          checkpointRef: input.fromCheckpointRef,
        }),
        toCheckpointRef: resolveReadCheckpointRef({
          checkpoints,
          cwd: input.cwd,
          checkpointRef: input.toCheckpointRef,
        }),
      }).pipe(Effect.flatMap((refs) => checkpoints.diffCheckpoints({ ...input, ...refs }))),
    deleteCheckpointRefs: (input) =>
      checkpoints.deleteCheckpointRefs({
        ...input,
        checkpointRefs: input.checkpointRefs.filter(isSignalboxCheckpointRef),
      }),
  };
}

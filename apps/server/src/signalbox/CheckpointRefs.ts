import { CheckpointRef, type ThreadId } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";

import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";

const SIGNALBOX_CHECKPOINT_REFS_PREFIX = "refs/signalbox/checkpoints";
const T3_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${SIGNALBOX_CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

const isSignalboxCheckpointRef = (checkpointRef: CheckpointRef): boolean =>
  checkpointRef.startsWith(`${SIGNALBOX_CHECKPOINT_REFS_PREFIX}/`);

const legacyT3CheckpointRef = (checkpointRef: CheckpointRef): CheckpointRef | undefined => {
  const signalboxPrefix = `${SIGNALBOX_CHECKPOINT_REFS_PREFIX}/`;
  if (!checkpointRef.startsWith(signalboxPrefix)) return undefined;
  return CheckpointRef.make(
    `${T3_CHECKPOINT_REFS_PREFIX}/${checkpointRef.slice(signalboxPrefix.length)}`,
  );
};

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

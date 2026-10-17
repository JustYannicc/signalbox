import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { RunnerDrive } from "./RunnerDrive.ts";
import { DriveRefusedError, DriveTooLargeError } from "./RunnerDriveClient.ts";
import { finishDriveTurn } from "./RunnerTurnDrive.ts";

const runId = RunId.make("run-1");

const finishing = (
  finishTurn: RunnerDrive["finishTurn"],
  options: {
    readonly drive?: Partial<RunnerDrive>;
    readonly resolve?: (prompt: string) => Effect.Effect<boolean>;
    readonly emitted?: Array<RunnerItem>;
  } = {},
) =>
  Effect.gen(function* () {
    const emitted = options.emitted ?? [];
    yield* finishDriveTurn({
      runId,
      turnId: "native-1",
      threadId: "thread-1",
      views: { shortcuts: [], context: null },
      drive: {
        finishTurn,
        recordCheckpoint: () => Effect.void,
        ...options.drive,
      } as unknown as RunnerDrive,
      emit: (item) => Effect.sync(() => void emitted.push(item)),
      resolve: options.resolve ?? (() => Effect.succeed(false)),
    });
    return emitted.flatMap((item) => (item.kind === "drive.notice" ? [item.message] : []));
  });

describe("finishDriveTurn", () => {
  it.effect("says nothing about saving when the thread has nothing saved", () =>
    Effect.gen(function* () {
      const notices = yield* finishing(() =>
        Effect.succeed({ checkpoint: null, outcome: { _tag: "nothing_saved" } }),
      );
      expect(notices).toEqual([]);
    }),
  );

  it.effect("says saved files didn't land on main, and why", () =>
    Effect.gen(function* () {
      const notices = yield* finishing(() =>
        Effect.succeed({
          checkpoint: { start: null, commit: "c".repeat(40), files: [] },
          outcome: { _tag: "not_landed", reason: "Main moved." },
        }),
      );
      expect(notices).toEqual(["This turn's files are saved but not merged yet: Main moved."]);
    }),
  );

  it.effect("says what's too big when the drive can't take the turn's files", () =>
    Effect.gen(function* () {
      const notices = yield* finishing(() =>
        Effect.fail(new DriveTooLargeError({ message: "big.bin is 80 MB." })),
      );
      expect(notices).toEqual(["Saving this turn's files failed: big.bin is 80 MB."]);
    }),
  );

  it.effect("keeps any other failure generic", () =>
    Effect.gen(function* () {
      const notices = yield* finishing(() => Effect.die(new Error("disk on fire")));
      expect(notices).toEqual(["Saving this turn's files failed; the last auto-save is kept."]);
    }),
  );

  it.effect("reports the saved diff and resolves a merge when checkpoint registration fails", () =>
    Effect.gen(function* () {
      const emitted: Array<RunnerItem> = [];
      let merged = false;
      const checkpoint = { start: null, commit: "c".repeat(40), files: [] };
      const notices = yield* finishing(
        () => Effect.succeed({ checkpoint, outcome: { _tag: "conflict", files: ["shared.txt"] } }),
        {
          emitted,
          resolve: () => Effect.succeed(true),
          drive: {
            recordCheckpoint: () => Effect.die(new Error("network unavailable")),
            continueAfterResolution: Effect.sync(() => {
              merged = true;
              return { _tag: "saved", head: checkpoint.commit } as const;
            }),
          },
        },
      );
      expect(merged).toBe(true);
      expect(emitted).toContainEqual({ kind: "drive.checkpoint", runId, ...checkpoint });
      expect(notices).toEqual([
        "Retaining this turn's checkpoint failed; its files remain saved.",
        "Merging the latest version conflicted in shared.txt. Resolving it.",
      ]);
    }),
  );

  it.effect("abandons an unresolved merge after the drive refuses checkpoint registration", () =>
    Effect.gen(function* () {
      let abandoned = false;
      const notices = yield* finishing(
        () =>
          Effect.succeed({
            checkpoint: { start: null, commit: "c".repeat(40), files: [] },
            outcome: { _tag: "conflict", files: ["shared.txt"] },
          }),
        {
          drive: {
            recordCheckpoint: () =>
              Effect.fail(new DriveRefusedError({ message: "Checkpoint commit is not public." })),
            abandonMerge: Effect.sync(() => {
              abandoned = true;
              return { _tag: "not_landed", reason: "The merge was dropped." } as const;
            }),
          },
        },
      );
      expect(abandoned).toBe(true);
      expect(notices).toEqual([
        "Retaining this turn's checkpoint failed: Checkpoint commit is not public.",
        "Merging the latest version conflicted in shared.txt. Resolving it.",
        "This turn's files are saved but not merged yet: The merge was dropped.",
      ]);
    }),
  );
});

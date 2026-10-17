import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { RunnerDrive } from "./RunnerDrive.ts";
import { DriveTooLargeError } from "./RunnerDriveClient.ts";
import { finishDriveTurn } from "./RunnerTurnDrive.ts";

const runId = RunId.make("run-1");

const finishing = (finishTurn: RunnerDrive["finishTurn"]) =>
  Effect.gen(function* () {
    const emitted: Array<RunnerItem> = [];
    yield* finishDriveTurn({
      runId,
      turnId: "native-1",
      threadId: "thread-1",
      views: { shortcuts: [], context: null },
      drive: { finishTurn, recordCheckpoint: () => Effect.void } as unknown as RunnerDrive,
      emit: (item) => Effect.sync(() => void emitted.push(item)),
      resolve: () => Effect.succeed(false),
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
});

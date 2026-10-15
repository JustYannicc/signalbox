import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DriveCheckpoint, DriveOutcome, RunnerDrive } from "./RunnerDrive.ts";
import { finishDriveTurn } from "./RunnerTurnDrive.ts";

const runId = RunId.make("run-1");

const finish = (checkpoint: DriveCheckpoint | null, outcome: DriveOutcome) =>
  Effect.gen(function* () {
    const drive: RunnerDrive = {
      prepare: () => Effect.die(new Error("not in this test")),
      autosave: Effect.void,
      flush: Effect.void,
      finishTurn: () => Effect.succeed({ checkpoint, outcome }),
      continueAfterResolution: Effect.die(new Error("not in this test")),
      abandonMerge: Effect.die(new Error("not in this test")),
      saveBranch: () => Effect.die(new Error("not in this test")),
    };
    const emitted: Array<RunnerItem> = [];
    yield* finishDriveTurn({
      runId,
      message: "Hi",
      drive,
      emit: (item) => Effect.sync(() => void emitted.push(item)),
      resolve: () => Effect.succeed(false),
    });
    return emitted;
  });

describe("finishDriveTurn", () => {
  it.effect("says nothing about saving when the thread has nothing saved", () =>
    Effect.gen(function* () {
      expect(yield* finish(null, { _tag: "nothing_saved" })).toEqual([]);
    }),
  );

  it.effect("reports saved files that didn't land on main", () =>
    Effect.gen(function* () {
      const checkpoint = { start: null, commit: "c".repeat(40), files: [] };
      expect(yield* finish(checkpoint, { _tag: "not_landed", reason: "Main moved." })).toEqual([
        { kind: "drive.checkpoint", runId, ...checkpoint },
        {
          kind: "drive.notice",
          runId,
          message: "This turn's files are saved but not merged yet: Main moved.",
        },
      ]);
    }),
  );
});

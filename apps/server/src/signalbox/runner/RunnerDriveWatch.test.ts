import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { SAVE_FAILED_NOTICE, SAVED_AGAIN_NOTICE, watchChanges } from "./RunnerDriveWatch.ts";

/** A watcher over a fake drive: `changed` answers what the test says, `save` records each call. */
const fakeDrive = () => {
  const state = { changed: false, failing: null as string | null, saves: 0 };
  const notices: Array<string> = [];
  let savedAgain = 0;
  return {
    state,
    notices,
    get savedAgain() {
      return savedAgain;
    },
    watch: watchChanges({
      interval: "2 seconds",
      changed: Effect.sync(() => state.changed),
      save: Effect.suspend(() => {
        state.saves++;
        if (state.failing !== null) return Effect.fail(state.failing);
        state.changed = false;
        return Effect.void;
      }),
      notice: (message) => Effect.sync(() => void notices.push(message)),
      onSavedAgain: Effect.sync(() => void (savedAgain += 1)),
    }),
  };
};

describe("watchChanges", () => {
  it.effect("saves within one interval of a change, and does nothing while nothing changes", () =>
    Effect.gen(function* () {
      const drive = fakeDrive();
      const fiber = yield* Effect.forkChild(drive.watch);
      yield* TestClock.adjust("10 seconds");
      expect(drive.state.saves).toBe(0);

      // A dev server writes a file after the turn ended.
      drive.state.changed = true;
      yield* TestClock.adjust("2 seconds");
      expect(drive.state.saves).toBe(1);
      yield* TestClock.adjust("10 seconds");
      expect(drive.state.saves).toBe(1);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("says once that saving fails, keeps trying, and says when it works again", () =>
    Effect.gen(function* () {
      const drive = fakeDrive();
      const fiber = yield* Effect.forkChild(drive.watch);
      drive.state.changed = true;
      drive.state.failing = "the drive is unreachable";
      yield* TestClock.adjust("6 seconds");
      expect(drive.state.saves).toBe(3);
      expect(drive.notices).toEqual([`${SAVE_FAILED_NOTICE} the drive is unreachable`]);

      drive.state.failing = null;
      yield* TestClock.adjust("2 seconds");
      expect(drive.savedAgain).toBe(1);
      expect(drive.notices).toEqual([
        `${SAVE_FAILED_NOTICE} the drive is unreachable`,
        SAVED_AGAIN_NOTICE,
      ]);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * Changes stream into the drive as they happen (#493), not only after the
 * agent's tool calls: a dev server or a background job writing after the
 * turn ended is saved within one `interval`. Each tick asks the drive whether
 * anything changed since its last save (`RunnerDrive.unsaved`, a `find` that
 * stops at the first newer file) and saves when it did, so a machine lost
 * without warning loses at most about one interval of work.
 *
 * A save that fails is retried next tick. The thread hears once when saving
 * starts failing and once when it works again, never every tick.
 */

export const SAVE_FAILED_NOTICE =
  "Saving this thread's latest changes failed; Signalbox keeps trying:";
export const SAVED_AGAIN_NOTICE = "This thread's files are saved again.";

export const watchChanges = <E>(input: {
  readonly interval: Duration.Input;
  /** Whether anything changed since the last save. */
  readonly changed: Effect.Effect<boolean, E>;
  /** Fails with why, in the thread's terms. */
  readonly save: Effect.Effect<void, string>;
  /** What the thread should hear. */
  readonly notice: (message: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    let failing = false;
    while (true) {
      yield* Effect.sleep(input.interval);
      const outcome = yield* Effect.gen(function* () {
        if (!(yield* input.changed)) return;
        yield* input.save;
      }).pipe(Effect.exit);
      if (outcome._tag === "Failure") {
        if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
        yield* Effect.logWarning("saving the drive's changes failed", Cause.pretty(outcome.cause));
        const reason = Cause.findErrorOption(outcome.cause);
        if (!failing) {
          yield* input.notice(
            `${SAVE_FAILED_NOTICE} ${reason._tag === "Some" && typeof reason.value === "string" ? reason.value : "Signalbox couldn't check this thread's files."}`,
          );
        }
        failing = true;
      } else if (failing) {
        failing = false;
        yield* input.notice(SAVED_AGAIN_NOTICE);
      }
    }
  });

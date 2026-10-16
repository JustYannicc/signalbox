import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";

import type { DriveOutcome, MainConflict, RunnerDrive } from "./RunnerDrive.ts";
import { DriveRefusedError, DriveTooLargeError } from "./RunnerDriveClient.ts";

/** Why a save failed, when it says so in the thread's person's terms: the drive refused it, and why. */
const isUserFacing = Schema.is(Schema.Union([DriveTooLargeError, DriveRefusedError]));

/** What the thread hears about a save that failed: the drive's own reason, or no internals. */
export const saveFailureReason = (error: unknown) =>
  isUserFacing(error) ? error.message : "Signalbox couldn't reach this thread's storage.";

/**
 * How a turn that works in a drive ends (#131): its files are committed and
 * reported as the turn's checkpoint, `main` is merged in, and the branch lands
 * on `main`. A merge conflict goes back to the agent as one more provider
 * turn in the same run, while it still has the context; if that does not
 * resolve it, the merge is dropped and the thread's branch stays saved for the
 * next turn to land. Only then does the thread hear that the turn ended, so it
 * records completion after the drive does.
 */

/** Tries the agent gets at a conflict before the merge is dropped. */
const RESOLUTION_ATTEMPTS = 2;

/** Tool items that may change files: a drive saves after each one completes. */
export const FILE_CHANGING_ITEMS: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "file_change",
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

const resolutionPrompt = (
  files: ReadonlyArray<string>,
  lead = "Signalbox merged the latest version of this drive into your work, and these files conflict:",
) =>
  [
    lead,
    ...files.map((file) => `- ${file}`),
    "",
    "Resolve every conflict now: keep what both sides meant, and remove all conflict markers.",
    "Do not commit or run git merge commands; Signalbox finishes the merge when you stop.",
  ].join("\n");

const notice = (runId: RunId, message: string): RunnerItem => ({
  kind: "drive.notice",
  runId,
  message,
});

/**
 * Has the agent resolve `outcome`'s conflict, at most `RESOLUTION_ATTEMPTS`
 * times: `resolve` runs it on the files still conflicted and answers whether
 * that completed. Answers the drive's outcome after the last attempt.
 */
const resolveConflicts = (
  outcome: DriveOutcome,
  drive: RunnerDrive,
  resolve: (files: ReadonlyArray<string>) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    let current = outcome;
    for (
      let attempt = 1;
      current._tag === "conflict" && attempt <= RESOLUTION_ATTEMPTS;
      attempt++
    ) {
      if (!(yield* resolve(current.files))) break;
      current = yield* drive.continueAfterResolution;
    }
    return current;
  });

/**
 * Ends `runId`'s turn in its drive. `resolve` runs the agent once more with a
 * prompt and answers whether that provider turn completed.
 */
export const finishDriveTurn = (input: {
  readonly runId: RunId;
  readonly message: string;
  readonly drive: RunnerDrive;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  readonly resolve: (prompt: string) => Effect.Effect<boolean>;
}) =>
  Effect.gen(function* () {
    const { runId, drive, emit } = input;
    const finished = yield* drive.finishTurn({ message: input.message });
    if (finished.checkpoint !== null) {
      yield* emit({ kind: "drive.checkpoint", runId, ...finished.checkpoint });
    }
    let outcome = yield* resolveConflicts(finished.outcome, drive, (files) =>
      emit(
        notice(
          runId,
          `Merging the latest version conflicted in ${files.join(", ")}. Resolving it.`,
        ),
      ).pipe(Effect.andThen(input.resolve(resolutionPrompt(files)))),
    );
    if (outcome._tag === "conflict") outcome = yield* drive.abandonMerge;
    if (outcome._tag === "held") yield* emit(notice(runId, outcome.reason));
    if (outcome._tag === "not_landed") {
      yield* emit(
        notice(runId, `This turn's files are saved but not merged yet: ${outcome.reason}`),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.logError("saving the turn's files failed", Cause.pretty(cause)).pipe(
        Effect.andThen(
          input.emit(
            notice(
              input.runId,
              isUserFacing(error)
                ? `Saving this turn's files failed: ${error.message}`
                : "Saving this turn's files failed; the last auto-save is kept.",
            ),
          ),
        ),
      );
    }),
  );

/**
 * Before a turn whose start found a merged pull request's main conflicting
 * (#495, `RunnerDrive.prepare`): the merge is redone and the agent resolves
 * it first, the way it does a conflict at a turn's end, and the turn then
 * runs on the merged branch. Unresolved, the merge is dropped and the turn
 * runs on the branch as it was, saying so; the next turn start tries again.
 * Either way no merge is left in progress. Answers whether main is in.
 * `stopped`: the thread stopped the run, so no turn follows to hear about it.
 */
export const resolveMainConflict = (input: {
  readonly runId: RunId;
  readonly conflict: MainConflict;
  readonly drive: RunnerDrive;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  readonly resolve: (prompt: string) => Effect.Effect<boolean>;
  readonly stopped: Effect.Effect<boolean>;
}) => {
  const { runId, conflict, drive, emit } = input;
  const main = conflict.branch;
  const notMerged = (why: string) =>
    Effect.flatMap(input.stopped, (stopped) =>
      stopped
        ? Effect.void
        : emit(
            notice(
              runId,
              `The latest ${main} isn't merged in: ${why}. This turn works on the branch as it was; the next one tries again.`,
            ),
          ),
    );
  return Effect.gen(function* () {
    yield* emit(
      notice(
        runId,
        `Pull request #${conflict.pullRequest} merged, so this thread is taking in the latest ${main}. It conflicts in ${conflict.files.join(", ")}; resolving that first.`,
      ),
    );
    const lead = `Pull request #${conflict.pullRequest} merged. Before the next request, Signalbox merged the latest ${main} into this thread's branch, so its next pull request carries only new work, and these files conflict:`;
    const outcome = yield* resolveConflicts(yield* drive.takeInMain, drive, (files) =>
      input.resolve(resolutionPrompt(files, lead)),
    );
    if (outcome._tag === "saved") {
      yield* emit(notice(runId, `The latest ${main} is merged in.`));
      return true;
    }
    if (outcome._tag === "conflict") yield* drive.abandonMerge;
    yield* notMerged(
      outcome._tag === "conflict"
        ? `${outcome.files.join(", ")} still conflicted`
        : outcome._tag === "not_landed"
          ? outcome.reason
          : "nothing to merge",
    );
    return false;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("taking in the merged main failed", Cause.pretty(cause)).pipe(
        Effect.andThen(Effect.ignore(drive.abandonMerge)),
        Effect.andThen(notMerged("taking it in failed")),
        Effect.as(false),
      ),
    ),
  );
};

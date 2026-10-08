import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { DriveOutcome, RunnerDrive } from "./RunnerDrive.ts";

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

const resolutionPrompt = (files: ReadonlyArray<string>) =>
  [
    "Signalbox merged the latest version of this drive into your work, and these files conflict:",
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
    let outcome: DriveOutcome = finished.outcome;
    for (
      let attempt = 1;
      outcome._tag === "conflict" && attempt <= RESOLUTION_ATTEMPTS;
      attempt++
    ) {
      yield* emit(
        notice(
          runId,
          `Merging the latest version conflicted in ${outcome.files.join(", ")}. Resolving it.`,
        ),
      );
      if (!(yield* input.resolve(resolutionPrompt(outcome.files)))) break;
      outcome = yield* drive.continueAfterResolution;
    }
    if (outcome._tag === "conflict") outcome = yield* drive.abandonMerge;
    if (outcome._tag === "not_landed") {
      yield* emit(
        notice(runId, `This turn's files are saved but not merged yet: ${outcome.reason}`),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("saving the turn's files failed", Cause.pretty(cause)).pipe(
        Effect.andThen(
          input.emit(
            notice(input.runId, "Saving this turn's files failed; the last auto-save is kept."),
          ),
        ),
      ),
    ),
  );

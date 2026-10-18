import type { CheckpointViews, DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import {
  type MachineClass,
  type MachineUsage,
  onFreshSession,
  type RunnerItem,
  type RunnerLogLevel,
  type RunnerMessageInput,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { SecretsAccess } from "@signalbox/runner-protocol/SecretsProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import type { FeedbackOutcome, FeedbackRequest } from "@signalbox/runner-protocol/FeedbackProtocol";
import type { PullOperation } from "@signalbox/runner-protocol/PullProtocol";
import {
  MessageId,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import type * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeAssistantStreamingFilter } from "../../orchestration-v2/assistantStreaming.ts";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { stripUnservedToolOutputImageBytes } from "../../orchestration-v2/toolOutputImageBytes.ts";
import type { HarnessStderr } from "./harnessStderr.ts";
import type { RunnerAttachments } from "./RunnerAttachments.ts";
import type { RunnerDependencies } from "./RunnerDependencies.ts";
import type { MainConflict, RunnerDrive, RunnerDriveError } from "./RunnerDrive.ts";
import { DriveClientError, DriveRefusedError, DriveTooLargeError } from "./RunnerDriveClient.ts";
import { RunnerGitError } from "./RunnerGit.ts";
import { RunnerInstructionsError } from "./RunnerInstructions.ts";
import { type RunnerSecrets, SecretsRegisterError } from "./RunnerSecrets.ts";
import type { RunnerSessions } from "./RunnerSessions.ts";
import { causeText, runnerLog } from "./runnerLog.ts";
import { type OutgrownCommandDecision, outgrownCommandDecision } from "./RunnerMachineClass.ts";
import {
  FILE_CHANGING_ITEMS,
  finishDriveTurn,
  captureInterruptedDriveTurn,
  resolveMainConflict,
  saveFailureReason,
} from "./RunnerTurnDrive.ts";
import { SAVED_AGAIN_NOTICE, watchChanges } from "./RunnerDriveWatch.ts";
import { isUnmeasured } from "./RunnerUsage.ts";
import { makeRunnerFeedback } from "./RunnerFeedback.ts";

/**
 * Drives one thread's turns through the provider adapters, the way the
 * server's turn start does for a self-hosted thread: one adapter session per
 * provider, the thread's provider thread ensured (first turn) or resumed
 * natively (later turns, falling back to a fresh one), then `startTurn`.
 * Everything that happens is reported through `emit` as Runner items, in
 * order. Adapter events pass the same filters the server applies before it
 * stores them (assistant streaming cadence, tool output images), then go out
 * in their JSON encoding.
 *
 * Each turn hands the harnesses its model token before anything else, so every
 * model request the turn makes carries that turn's credential.
 *
 * A turn with a drive works in a checkout of it (`RunnerDrive.ts`): checked
 * out before the harness starts, saved after each tool item that may change
 * files, and landed before the turn's end is reported (`RunnerTurnDrive.ts`).
 * When its start took in a merged pull request's main and that conflicted,
 * the agent resolves it before the turn's own message.
 * Once the checkout is in place, its dependency trees are brought in step
 * with their lockfiles (`RunnerDependencies.ts`), one turn at a time.
 * Harnesses read their instructions when a session starts, so when the
 * instructions the drive's shortcuts bring change, the provider's session is
 * restarted and the thread resumed natively, which swaps them in. The folder's
 * secrets (`RunnerSecrets.ts`) are environment variables of the session, so a
 * change to them restarts it the same way.
 *
 * The harness's own session leaves the machine as it is written
 * (`RunnerSessions.ts`): it is restored before the harness loads it, an event
 * reporting something complete waits until the rows behind it are durable,
 * and a turn whose rows stop being saved is stopped. A turn that continues one
 * lost with its machine (`restartContinuationOfRunId`) resumes the restored
 * session natively.
 *
 * On a light machine, a turn that starts a build or runs out of memory moves
 * to a heavy one (`moveUp`), resuming there the same way.
 *
 * The machine's usage goes out just before each `turn.started`, right after
 * each turn's end is reported, and every half minute while a turn runs (every
 * 5 minutes while idle), and problems the Runner hits go out as log lines, so
 * a turn's diagnostic record holds both. The Runner's own logs for a turn
 * carry its trace id.
 */

export class RunnerTurnError extends Schema.TaggedError<RunnerTurnError>()("RunnerTurnError", {
  message: Schema.String,
}) {}

export interface RunnerTurns {
  readonly uploadFeedback?: (request: FeedbackRequest) => Effect.Effect<FeedbackOutcome>;
  /**
   * Starts a turn, as `turn.start` hands it over. A run already started is
   * ignored, so the thread can repeat itself.
   */
  readonly start: (start: {
    readonly turn: RunnerTurn;
    readonly modelToken: string;
    readonly drive?: DriveAccess | null;
    readonly sessions?: SessionAccess | null;
    readonly secrets?: SecretsAccess;
  }) => Effect.Effect<void>;
  /** Stops `runId`, wherever it is: loading, or running on the harness. */
  readonly interrupt: (runId: RunId) => Effect.Effect<void>;
  /**
   * Hands `message` to `runId`'s turn on the harness (#562), once the harness
   * has named it. Each message is taken once, so the thread can repeat itself.
   */
  readonly steer: (runId: RunId, message: RunnerMessageInput) => Effect.Effect<void>;
  /** Applies one selected remote pull, or reports a durable refusal/result. */
  readonly pull: (message: {
    readonly operation: PullOperation;
    readonly drive: DriveAccess;
  }) => Effect.Effect<void>;
  /** Stops every turn but `runId`, the one the thread still considers live. */
  readonly keepOnly: (runId: RunId | null) => Effect.Effect<void>;
  /**
   * Saves everything the machine wrote, for a machine about to go (#493): the
   * drive, then each harness's session rows. Answers what couldn't be saved,
   * in the thread's terms.
   */
  readonly drain: Effect.Effect<ReadonlyArray<string>>;
  /** Every run this process was handed, ended or not. */
  readonly taken: Effect.Effect<ReadonlyArray<RunId>>;
}

/** An adapter session, and the shortcut instructions and secrets it was started with. */
interface OpenSession {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly loaded: SessionLoad;
  readonly scope: Scope.Closeable;
}

/** What a harness reads only as its session starts. */
interface SessionLoad {
  readonly instructions: string;
  /** The version of the folder's secrets (`RunnerSecrets.ts`). */
  readonly secrets: number;
}

/** A run waiting on the agent to resolve a merge (`finishing`). */
interface Held {
  waiting: Deferred.Deferred<boolean> | null;
  stopped?: boolean;
}

/** A run this machine was handed, until the harness ends its turn. */
interface Turn {
  readonly turn: RunnerTurn;
  readonly attemptId: RunAttemptId;
  status: "loading" | "running" | "stopped";
  session: ProviderAdapterV2SessionRuntime | null;
  providerThread: OrchestrationV2ProviderThread | null;
  providerTurnId: ProviderTurnId | null;
  /** Done once the run is off this machine: its turn ended, or it never reached the harness. */
  readonly ended: Deferred.Deferred<void>;
  /** The turn's session token, to bring a steer's attachments. */
  readonly sessionToken: string | null;
  /** Messages steered in, by id, and the ones waiting for the harness to name its turn. */
  readonly steered: Set<string>;
  readonly steers: Array<RunnerMessageInput>;
  /** The view this run pinned while its checkout and session loaded. */
  pinnedContext: Fiber.Fiber<CheckpointViews["context"], never> | null;
}

const encodeAdapterEvent = Schema.encodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event));

const isInstructionsError = Schema.is(RunnerInstructionsError);
const isTurnError = Schema.is(RunnerTurnError);
const isRunnerGitError = Schema.is(RunnerGitError);
const isDriveClientError = Schema.is(DriveClientError);
const isDriveTooLarge = Schema.is(Schema.Union([DriveTooLargeError, DriveRefusedError]));

/**
 * The failure text a thread may store: bounded and with credentials redacted.
 * Instructions too big to load say so in their own words (`RunnerInstructions.ts`),
 * and the Runner's own reasons (`RunnerTurnError`) say why instead of "Provider turn failed."
 */
const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (isInstructionsError(error)) return error.message;
  return makeProviderFailure(isTurnError(error) ? { message: error.message } : { cause: error })
    .message;
};

const machineStateCause = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.Literals(["ENOTCONN", "EIO", "EROFS", "EACCES", "EPERM", "ENOENT", "ENOSPC"]),
  }),
);

const machineStateError = (error: PlatformError.PlatformError) => {
  // Keep the OS code, without exposing a credential-bearing path or arbitrary error text.
  const cause = machineStateCause(error.cause);
  const code = Option.isSome(cause) ? cause.value.code : error.reason._tag;
  return new RunnerTurnError({
    message: `Signalbox couldn't write this machine's state (${code === "ENOTCONN" ? "ENOTCONN: filesystem disconnected" : code}).`,
  });
};

/** Why a drive couldn't be readied, in words a thread may show: ours, not a file system's. */
const drivePrepareError = (error: RunnerDriveError) =>
  new RunnerTurnError({
    message: `Signalbox couldn't get this thread's files ready: ${
      isRunnerGitError(error) || isDriveClientError(error) || isDriveTooLarge(error)
        ? error.message
        : "a file operation on its machine failed."
    }`,
  });

const USAGE_INTERVAL = "30 seconds";
/**
 * How long a stopped turn has to end before the next one starts without it:
 * past Claude's own 10 s wait for an interrupted query to close. A harness
 * still running then has its session restarted, which ends the turn with it.
 */
const WIND_DOWN = "15 seconds";
/** How often the drive looks for changes to stream in (#493): about what a lost machine loses. */
const WATCH_INTERVAL = "2 seconds";
/** While no turn runs, every this many intervals (5 min): each report wakes the thread's object. */
const IDLE_USAGE_EVERY = 10;
/** Room a failure line gives the CLI's stderr, from its end: the last lines say why it died. */
const STDERR_TAIL_CHARS = 1_000;
/** Room for the cause itself when stderr follows, so the line's cap never cuts the stderr. */
const CAUSE_CHARS = 900;

/** Puts `traceId` on the logs of `effect`, when there is one. */
const withTrace =
  (traceId: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    traceId === null ? effect : Effect.annotateLogs(effect, { traceId });

export const makeRunnerTurns = Effect.fn("makeRunnerTurns")(function* (input: {
  readonly threadId: ThreadId;
  readonly adapters: ReadonlyMap<ProviderInstanceId, ProviderAdapterV2["Service"]>;
  /** The thread's working directory on this machine. */
  readonly cwd: string;
  /** Makes `token` the one the harnesses present to the ModelGateway. */
  readonly useModelToken: (token: string) => Effect.Effect<void, PlatformError.PlatformError>;
  /** The machine's usage so far (`RunnerUsage.ts`). */
  readonly usage: Effect.Effect<MachineUsage>;
  /** What the harness CLIs wrote to stderr, quoted in failure lines (`harnessStderr.ts`). */
  readonly stderr?: Pick<HarnessStderr, "mark" | "since">;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  /** Installs dependencies before a heavy turn; light turns move up when they need them. */
  readonly dependencies?: RunnerDependencies;
  /** Preview restoration shares the checkout preparation lock with turns. */
  readonly preparing?: Semaphore.Semaphore;
  /** The thread's drive, checked out in `cwd`. Absent: turns run in a plain directory. */
  readonly openDrive?: (access: DriveAccess) => Effect.Effect<RunnerDrive, never, Scope.Scope>;
  /** A drive opened by preview before this Runner has started a turn. */
  readonly previewDrive?: () => RunnerDrive | null;
  /** Where the harnesses' sessions are kept. Absent: they stay on this machine. */
  readonly sessions?: RunnerSessions;
  /** Brings the thread's attachments to this machine, with the turn's session token (`RunnerAttachments.ts`). */
  readonly attachments?: RunnerAttachments;
  /** This machine's class. On a light one, a turn that needs more moves up (`RunnerMachineClass.ts`). */
  readonly machineClass?: MachineClass;
  /** Pins this turn's view of every drive the user can read (#141). Never fails. */
  readonly pinDrives?: (access: DriveAccess) => Effect.Effect<CheckpointViews["context"]>;
  /** The folder's secrets for the harness sessions. Absent: none load on this machine. */
  readonly secrets?: RunnerSecrets;
  /** Registers them with the thread, with the turn's session token (`makeSecretsRegistrar`). */
  readonly registerSecrets?: (
    token: string,
    secrets: ReadonlyArray<SecretValue>,
  ) => Effect.Effect<void, SecretsRegisterError>;
}) {
  const scope = yield* Effect.scope;
  const logAnnotations = yield* References.CurrentLogAnnotations;
  const sessions = new Map<ProviderInstanceId, OpenSession>();
  const feedback = makeRunnerFeedback(
    input.threadId,
    (instanceId) => sessions.get(instanceId)?.runtime,
  );
  const turns = new Map<RunId, Turn>();
  /** Drains hold the drive while the machine saves before it leaves. */
  let draining = false;
  /** Runs this machine already took, so a repeated `turn.start` starts nothing. */
  const taken = new Set<RunId>();
  /** `turn` is off this machine: whatever waits for it to wind down goes on. */
  const forget = (runId: RunId, turn: Turn) => {
    if (turns.get(runId) === turn) turns.delete(runId);
    Deferred.doneUnsafe(turn.ended, Exit.void);
  };
  /** The run adapter events belong to: the latest one started. */
  let latestRunId: RunId | null = null;
  let latestTraceId: string | null = null;
  /** Where the latest run's stderr starts. */
  let latestStderr = 0;
  /** A failure line: the cause, then what the CLIs said on stderr since `mark`. */
  // Secrets are masked before anything is cut short, so no piece of one is left to send.
  const mask = input.secrets?.mask ?? ((text: string) => text);
  const log = (runId: RunId | null, level: RunnerLogLevel, text: string) =>
    runnerLog(runId, level, mask(text));
  const failureLine = (what: string, cause: Cause.Cause<unknown>, mark: number) => {
    const stderr = mask(input.stderr?.since(mark) ?? "");
    const text = mask(causeText(cause));
    if (stderr === "") return `${what}: ${text}`;
    const tail =
      stderr.length > STDERR_TAIL_CHARS ? `…${stderr.slice(-STDERR_TAIL_CHARS)}` : stderr;
    const head = text.length > CAUSE_CHARS ? `${text.slice(0, CAUSE_CHARS)}…` : text;
    return `${what}: ${head}\nThe CLI's stderr:\n${tail}`;
  };
  /** The run on the harness, from its `turn.started` until its end is reported. */
  let runningRunId: RunId | null = null;
  // A run's usage and the items it brackets go out under one lock, so a
  // half-minute report never lands before a run's start or after its end.
  const ordered = yield* Semaphore.make(1);
  const pullGate = yield* Semaphore.make(1);

  /** Emits the usage so far, unless the machine cannot measure any of it. */
  const reportUsage = (runId: RunId | null) =>
    Effect.flatMap(input.usage, (usage) =>
      isUnmeasured(usage) ? Effect.void : input.emit({ kind: "usage", runId, usage }),
    );
  /** The drive, opened by the first turn that names it; one per machine generation. */
  let drive: { readonly driveId: string; readonly drive: RunnerDrive } | null = null;
  /** The drive whose changes stream in. */
  let watching: RunnerDrive | null = null;
  /**
   * Runs whose end is held until their files land, or whose start waits for a
   * conflict to be resolved, and the agent turn awaited for it. `stopped`: the
   * thread stopped the run meanwhile.
   */
  const finishing = new Map<RunId, Held>();
  /** Agent turns run to resolve a merge, by attempt, and their provider turns once named. */
  const mergeAttempts = new Set<RunAttemptId>();
  const mergeProviderTurns = new Set<ProviderTurnId>();
  /** Runs that moved to a heavy machine: this one does nothing more for them. */
  const outgrown = new Set<RunId>();
  /** Classified commands and dev-server tools, by item and phase. */
  const classified = new Set<string>();
  /** Moves eligible current-session commands or tools once in each execution phase. */
  const outgrownByOnce = (
    event: ProviderAdapterV2Event,
    runId: RunId | null,
    runtime: ProviderAdapterV2SessionRuntime,
    decision: OutgrownCommandDecision,
  ) => {
    if (event.type !== "turn_item.updated") return null;
    const item = event.turnItem;
    if (item.type !== "command_execution" && item.type !== "dynamic_tool") return null;
    if (
      input.machineClass !== "light" ||
      decision.reason === null ||
      runId === null ||
      runId !== latestRunId ||
      runId !== runningRunId
    ) {
      return null;
    }
    const owner = turns.get(runId);
    if (owner === undefined || owner.status !== "running" || owner.session !== runtime) return null;
    const { id, status } = item;
    const key = `${id}:${status === "running" || status === "pending" ? "start" : "end"}`;
    if (classified.has(key)) return null;
    classified.add(key);
    return { runId, reason: decision.reason };
  };

  /**
   * What the drive's watcher says (#493). The thread only takes notices for a
   * live run, so between turns they wait for the next one; a save that works
   * again before then leaves nothing to say.
   */
  let heldNotices: ReadonlyArray<string> = [];
  const driveNotice = (message: string) =>
    ordered.withPermits(1)(
      Effect.suspend(() => {
        const runId = runningRunId;
        if (runId !== null) return input.emit({ kind: "drive.notice", runId, message });
        heldNotices = message === SAVED_AGAIN_NOTICE ? [] : [...heldNotices, message];
        return Effect.logWarning(message);
      }),
    );

  /** Installs only on a machine that can keep the turn; a light machine moves up on demand. */
  const prepareDependencies = (runId: RunId) => {
    if (input.dependencies === undefined || input.machineClass === "light") return Effect.void;
    return input.dependencies.prepare(
      () => Effect.void,
      (update) => input.emit({ kind: "dependencies.progress", runId, ...update }),
    );
  };

  /** Turns and preview restoration must not race while preparing the checkout. */
  const preparing = input.preparing ?? (yield* Semaphore.make(1));

  const drain: RunnerTurns["drain"] = Effect.suspend(() => {
    draining = true;
    return Effect.gen(function* () {
      const unsaved: Array<string> = [];
      yield* preparing.withPermits(1)(
        Effect.gen(function* () {
          // Preview can open the writable checkout before a turn has claimed it.
          const currentDrive = drive?.drive ?? input.previewDrive?.() ?? null;
          if (currentDrive === null) return;
          const saved = yield* Effect.result(currentDrive.saveNow);
          if (saved._tag === "Failure") {
            unsaved.push(`Saving this thread's files failed: ${saveFailureReason(saved.failure)}`);
          }
        }),
      );
      if (input.sessions !== undefined) {
        for (const driver of new Set(
          [...input.adapters.values()].map((adapter) => adapter.driver),
        )) {
          const reason = yield* input.sessions.flush(driver);
          if (reason !== null) unsaved.push(`Saving the agent's session failed: ${reason}`);
        }
      }
      return unsaved;
    }).pipe(Effect.ensuring(Effect.sync(() => (draining = false))));
  });

  /**
   * Hands `runId` to a heavy machine (#134), on the same path as a lost
   * machine (#132) but with nothing in flight: its files and session rows are
   * saved as of now, then the thread hears it outgrew this machine and
   * continues it on a heavy one. What the harness does after that is dropped;
   * this machine is stopped once the thread asks for the next one.
   */
  const moveUp = (runId: RunId, reason: string) =>
    Effect.gen(function* () {
      outgrown.add(runId);
      yield* Effect.logInfo("the turn outgrew this machine", { runId, reason });
      const unsaved = yield* drain;
      if (unsaved.length > 0) {
        yield* interrupt(runId);
        yield* ordered.withPermits(1)(
          Effect.gen(function* () {
            if (runningRunId === runId) runningRunId = null;
            yield* input.emit({
              kind: "turn.failed",
              runId,
              message: `This turn could not move to a larger machine because its state could not be saved. ${unsaved.join(" ")}`,
            });
          }),
        );
        return;
      }
      yield* input.emit({ kind: "machine.outgrown", runId, reason });
    });

  const interruptNow = (turn: Turn) =>
    turn.session === null || turn.providerThread === null || turn.providerTurnId === null
      ? Effect.void
      : turn.session
          .interruptTurn({
            providerThread: turn.providerThread,
            providerTurnId: turn.providerTurnId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("interrupting the provider turn failed", Cause.pretty(cause)).pipe(
                Effect.andThen(
                  input.emit(
                    log(
                      turn.turn.runId,
                      "warning",
                      `interrupting the provider turn failed: ${causeText(cause)}`,
                    ),
                  ),
                ),
              ),
            ),
            withTrace(turn.turn.traceId),
          );

  /** Steers go to the harness one at a time, in the order they came. */
  const steering = yield* Semaphore.make(1);

  /** Hands `message` to `turn`'s harness turn, its files first; a refusal is logged, not fatal. */
  const steerNow = (turn: Turn, message: RunnerMessageInput) =>
    Effect.gen(function* () {
      const { session, providerThread, providerTurnId } = turn;
      if (session === null || providerThread === null || providerTurnId === null) return;
      if (
        input.attachments !== undefined &&
        turn.sessionToken !== null &&
        message.attachments.length > 0
      ) {
        yield* input.attachments.bring(turn.sessionToken, message.attachments);
      }
      yield* session.steerTurn({
        threadId: input.threadId,
        runId: turn.turn.runId,
        providerThread,
        providerTurnId,
        message,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the harness didn't take a steer", Cause.pretty(cause)).pipe(
          Effect.andThen(
            input.emit(
              log(
                turn.turn.runId,
                "warning",
                `the harness didn't take a message sent mid-turn: ${causeText(cause)}`,
              ),
            ),
          ),
        ),
      ),
      steering.withPermits(1),
      withTrace(turn.turn.traceId),
    );

  /** Hands the harness the steers that waited for it to name its turn, without holding up the caller. */
  const deliverSteers = (turn: Turn) =>
    turn.status !== "running" || turn.providerTurnId === null || turn.steers.length === 0
      ? Effect.void
      : Effect.asVoid(
          Effect.forkIn(
            Effect.forEach(turn.steers.splice(0), (message) => steerNow(turn, message), {
              discard: true,
            }),
            scope,
          ),
        );

  /** Learns each turn's native id, stops one asked to stop before then, and forgets ended ones. */
  const track = (event: ProviderAdapterV2Event) =>
    Effect.gen(function* () {
      if (event.type === "turn.terminal") {
        for (const [runId, turn] of turns) {
          if (turn.providerTurnId === event.providerTurnId) forget(runId, turn);
        }
        return;
      }
      if (event.type !== "provider_turn.updated") return;
      for (const turn of turns.values()) {
        if (turn.providerTurnId !== null || event.providerTurn.runAttemptId !== turn.attemptId) {
          continue;
        }
        turn.providerTurnId = event.providerTurn.id;
        yield* turn.status === "stopped" ? interruptNow(turn) : deliverSteers(turn);
      }
    });

  /** The drive a turn names, opened once per machine generation. */
  const driveFor = (access: DriveAccess) =>
    Effect.gen(function* () {
      // The token is fixed for this machine's generation, so the drive id names it.
      if (drive?.driveId === access.driveId) return drive.drive;
      if (input.openDrive === undefined) return null;
      const opened = yield* input.openDrive(access).pipe(Scope.provide(scope));
      drive = { driveId: access.driveId, drive: opened };
      return opened;
    });

  const pull: RunnerTurns["pull"] = (message) =>
    pullGate.withPermits(1)(
      Effect.gen(function* () {
        const opened = yield* driveFor(message.drive);
        if (opened === null) {
          yield* input.emit({ kind: "git.pull.interrupted", id: message.operation.id });
          return;
        }
        const blockedReason =
          turns.size > 0 || finishing.size > 0 || runningRunId !== null
            ? "This thread is busy; wait for its current turn to finish before pulling."
            : draining
              ? "This thread is saving before its machine leaves; try the pull again after it reconnects."
              : undefined;
        const result = yield* opened.pull(
          message.operation,
          message.drive.remoteToken,
          blockedReason,
        );
        yield* input.emit({
          kind: "git.pull.result",
          result: {
            ...result,
            ...(result.reason === null ? {} : { reason: mask(result.reason) }),
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("applying a selected drive pull failed", Cause.pretty(cause)).pipe(
            Effect.andThen(input.emit({ kind: "git.pull.interrupted", id: message.operation.id })),
          ),
        ),
      ),
    );

  /**
   * Runs the agent once more in `runId`'s turn and answers whether that
   * completed. `step` tells a conflict at the turn's start (`sync`) from one at
   * its end (`merge`).
   */
  const continueTurn = (
    runId: RunId,
    state: Turn,
    prompt: string,
    step: "sync" | "merge",
    attempt: number,
  ) =>
    Effect.gen(function* () {
      const held = finishing.get(runId);
      if (
        held === undefined ||
        held.stopped === true ||
        state.session === null ||
        state.providerThread === null
      ) {
        return false;
      }
      const ended = yield* Deferred.make<boolean>();
      const turn = state.turn;
      // Its own attempt: adapters name the provider turn, and Claude its prompt, after the attempt.
      const attemptId = RunAttemptId.make(`${turn.attemptId}:${step}:${attempt}`);
      // Its own end: the next turn waits for this agent turn, not the one it follows.
      const continuation: Turn = {
        ...state,
        attemptId,
        status: "running",
        providerTurnId: null,
        ended: Deferred.makeUnsafe<void>(),
      };
      held.waiting = ended;
      mergeAttempts.add(attemptId);
      turns.set(runId, continuation);
      yield* state.session
        .startTurn({
          appThread: turn.appThread,
          threadId: input.threadId,
          runId,
          runOrdinal: turn.runOrdinal,
          // Clear of the ordinals the thread gives its next runs, and of each other.
          providerTurnOrdinal:
            turn.providerTurnOrdinal * 1000 + (step === "sync" ? 100 : 0) + attempt,
          attemptId,
          rootNodeId: turn.rootNodeId,
          providerThread: state.providerThread,
          // Before the run's own turn, a fresh session has nothing to resume yet.
          ...(step === "sync" ? { nativeThreadHasTurns: turn.providerTurnOrdinal > 1 } : {}),
          message: {
            ...turn.message,
            messageId: MessageId.make(`${turn.message.messageId}:${step}:${attempt}`),
            text: prompt,
            attachments: [],
          },
          modelSelection: turn.modelSelection,
          runtimePolicy: {
            runtimeMode: turn.runtimeMode,
            interactionMode: turn.interactionMode,
            cwd: input.cwd,
          },
        })
        .pipe(
          // Never started: nothing will end it.
          Effect.onError(() =>
            Effect.sync(() => {
              held.waiting = null;
              forget(runId, continuation);
            }),
          ),
        );
      return yield* Deferred.await(ended);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("the agent could not resolve the merge", Cause.pretty(cause)).pipe(
          Effect.as(false),
        ),
      ),
    );

  /**
   * Drive bookkeeping for one adapter event. A tool item that may have changed
   * files starts a save. A completed turn's end is held (true: not delivered
   * now) until its files land; the end of an agent turn run to resolve a
   * conflict only wakes that wait.
   */
  const holdForDrive = (
    event: ProviderAdapterV2Event,
    deliver: (event: ProviderAdapterV2Event, runId: RunId) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const runId = latestRunId;
      const current = drive?.drive ?? null;
      if (current === null || runId === null) return false;
      if (event.type === "turn_item.updated") {
        if (event.turnItem.status === "completed" && FILE_CHANGING_ITEMS.has(event.turnItem.type)) {
          yield* current.autosave;
        }
        return false;
      }
      if (
        event.type === "provider_turn.updated" &&
        event.providerTurn.runAttemptId !== null &&
        mergeAttempts.has(event.providerTurn.runAttemptId)
      ) {
        mergeProviderTurns.add(event.providerTurn.id);
        return false;
      }
      if (event.type !== "turn.terminal") return false;
      // A merge step's end is never the run's, even after a stop already released its wait.
      if (mergeProviderTurns.delete(event.providerTurnId)) {
        const held = finishing.get(runId);
        const waiting = held?.waiting ?? null;
        if (held !== undefined) held.waiting = null;
        const continuation = turns.get(runId);
        if (continuation !== undefined && mergeAttempts.has(continuation.attemptId)) {
          forget(runId, continuation);
        }
        if (waiting !== null) yield* Deferred.succeed(waiting, event.status === "completed");
        return true;
      }
      const held = finishing.get(runId);
      const state = turns.get(runId);
      if (held !== undefined || state === undefined || event.status !== "completed") {
        // Interrupted or failed: what the agent did is kept as an auto-save.
        yield* current.autosave;
        if (held === undefined && state !== undefined && event.status !== "completed") {
          const context =
            state.pinnedContext === null ? null : yield* Fiber.join(state.pinnedContext);
          yield* captureInterruptedDriveTurn({
            runId,
            turnId: event.providerTurnId,
            threadId: input.threadId,
            drive: current,
            views: current.checkpointViews(context),
            emit: input.emit,
          });
        }
        return false;
      }
      finishing.set(runId, { waiting: null });
      yield* track(event);
      const context = state.pinnedContext === null ? null : yield* Fiber.join(state.pinnedContext);
      let attempts = 0;
      yield* finishDriveTurn({
        runId,
        turnId: event.providerTurnId,
        threadId: input.threadId,
        drive: current,
        views: current.checkpointViews(context),
        emit: input.emit,
        resolve: (prompt) => continueTurn(runId, state, prompt, "merge", ++attempts),
      }).pipe(
        Effect.andThen(deliver(event, runId)),
        Effect.ensuring(Effect.sync(() => finishing.delete(runId))),
        Effect.forkIn(scope),
      );
      return true;
    });

  const forward = (
    adapter: ProviderAdapterV2["Service"],
    runtime: ProviderAdapterV2SessionRuntime,
  ) => {
    const instanceId = adapter.instanceId;
    // A failed handoff can leave a provider winding down while the next run loads.
    const eventRunId = (event: ProviderAdapterV2Event) => {
      switch (event.type) {
        case "message.updated":
          return event.message.runId ?? latestRunId;
        case "node.updated":
          return event.node.runId ?? latestRunId;
        case "subagent.updated":
          return event.subagent.runId ?? latestRunId;
        case "plan.updated":
          return event.plan.runId ?? latestRunId;
      }
      if (event.type === "turn_item.updated" && event.turnItem.runId !== null) {
        return event.turnItem.runId;
      }
      const providerTurnId =
        event.type === "turn.terminal"
          ? event.providerTurnId
          : event.type === "provider_turn.updated"
            ? event.providerTurn.id
            : event.type === "turn_item.updated"
              ? event.turnItem.providerTurnId
              : event.type === "runtime_request.updated"
                ? event.runtimeRequest.providerTurnId
                : null;
      for (const [runId, turn] of turns) {
        if (
          (providerTurnId !== null && turn.providerTurnId === providerTurnId) ||
          (event.type === "provider_turn.updated" &&
            turn.attemptId === event.providerTurn.runAttemptId)
        )
          return runId;
      }
      return latestRunId;
    };
    const filterAssistant = makeAssistantStreamingFilter(
      DEFAULT_SERVER_SETTINGS.responseStreamingMode,
    );
    /** Sends `event` as `runId`'s; a held end goes out under its own run, whatever runs since. */
    const deliver = (
      event: ProviderAdapterV2Event,
      runId: RunId | null = latestRunId,
      suppressTranscript = false,
    ) =>
      Effect.gen(function* () {
        const delivered = filterAssistant(event, yield* Clock.currentTimeMillis);
        if (delivered === null || runId === null) return;
        // Complete only once the rows behind it would survive this machine.
        if (input.sessions !== undefined) yield* input.sessions.settle(adapter.driver, delivered);
        if (suppressTranscript) return;
        const stored =
          delivered.type === "turn_item.updated"
            ? { ...delivered, turnItem: stripUnservedToolOutputImageBytes(delivered.turnItem) }
            : delivered;
        const item: RunnerItem = {
          kind: "provider",
          runId,
          event: encodeAdapterEvent(stored) as Record<string, unknown>,
        };
        if (delivered.type !== "turn.terminal") return yield* input.emit(item);
        // The run's end as reported: its last usage sample follows it.
        yield* ordered.withPermits(1)(
          Effect.gen(function* () {
            yield* input.emit(item);
            if (runningRunId === runId) runningRunId = null;
            yield* reportUsage(runId);
          }),
        );
      });
    return runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const runIdBeforeDriveHold = eventRunId(event);
          if (runIdBeforeDriveHold !== null && outgrown.has(runIdBeforeDriveHold)) {
            // Its terminal still releases the next run's wait for this provider.
            yield* track(event);
            return;
          }
          if (yield* holdForDrive(event, (held, runId) => deliver(held, runId))) return;
          const originatingRunId = eventRunId(event);
          const commandDecision = outgrownCommandDecision(event);
          yield* track(event);
          yield* deliver(event, originatingRunId, commandDecision.suppressTranscript);
          const upgrade = outgrownByOnce(event, originatingRunId, runtime, commandDecision);
          if (upgrade !== null) yield* moveUp(upgrade.runId, upgrade.reason);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("provider event stream ended", Cause.pretty(cause)).pipe(
          Effect.andThen(
            input.emit(
              log(
                latestRunId,
                "error",
                failureLine("provider event stream ended", cause, latestStderr),
              ),
            ),
          ),
          withTrace(latestTraceId),
        ),
      ),
      // A session whose events ended is dead; the next turn opens a new one,
      // and a stopped turn on it has nothing left to wind down.
      Effect.ensuring(
        Effect.sync(() => {
          if (sessions.get(instanceId)?.runtime === runtime) sessions.delete(instanceId);
          for (const [runId, turn] of turns) {
            if (turn.session === runtime && turn.status === "stopped") forget(runId, turn);
          }
        }),
      ),
    );
  };

  const sessionFor = (
    adapter: ProviderAdapterV2["Service"],
    turn: RunnerTurn,
    runtimePolicy: ProviderAdapterV2RuntimePolicy,
    loaded: SessionLoad,
  ) =>
    Effect.gen(function* () {
      const open = sessions.get(adapter.instanceId);
      if (
        open !== undefined &&
        open.loaded.instructions === loaded.instructions &&
        open.loaded.secrets === loaded.secrets
      ) {
        return open.runtime;
      }
      // A stopped run may still be winding down on it; the next turn swaps them in then.
      if (open !== undefined && [...turns.values()].some((t) => t.session === open.runtime)) {
        return open.runtime;
      }
      if (open !== undefined) {
        // Nothing runs on it anymore: the thread resumes on the new one.
        sessions.delete(adapter.instanceId);
        yield* Effect.logInfo("what the harness loads changed; restarting its session", {
          instructions: open.loaded.instructions !== loaded.instructions,
          secrets: open.loaded.secrets !== loaded.secrets,
        });
        yield* Scope.close(open.scope, Exit.void);
      }
      const sessionScope = yield* Scope.fork(scope);
      const runtime = yield* adapter
        .openSession({
          threadId: input.threadId,
          providerSessionId: ProviderSessionId.make(
            `runner:${input.threadId}:${adapter.instanceId}`,
          ),
          modelSelection: turn.modelSelection,
          runtimePolicy,
        })
        .pipe(Scope.provide(sessionScope));
      sessions.set(adapter.instanceId, { runtime, loaded, scope: sessionScope });
      yield* forward(adapter, runtime).pipe(Effect.forkIn(sessionScope));
      return runtime;
    }).pipe(
      // The session outlives the turn that opened it, so its fibers don't carry that turn's trace.
      Effect.provideService(References.CurrentLogAnnotations, logAnnotations),
    );

  /**
   * Waits for every turn but `runId` still on `instanceId`'s session to end,
   * so the harness never gets a turn while it runs another. One that hasn't
   * ended by `WIND_DOWN` ends with its session, and the next turn resumes on
   * a new one.
   */
  const windDown = (instanceId: ProviderInstanceId, runId: RunId) =>
    Effect.gen(function* () {
      const open = sessions.get(instanceId);
      if (open === undefined) return;
      const winding = [...turns.entries()].filter(
        ([other, turn]) => other !== runId && turn.session === open.runtime,
      );
      if (winding.length === 0) return;
      const ended = yield* Effect.forEach(winding, ([, turn]) => Deferred.await(turn.ended), {
        discard: true,
      }).pipe(Effect.timeoutOption(WIND_DOWN));
      if (Option.isSome(ended)) return;
      yield* input.emit(
        log(
          runId,
          "warning",
          `a stopped turn was still running after ${WIND_DOWN}; restarting the agent's session`,
        ),
      );
      if (sessions.get(instanceId) === open) sessions.delete(instanceId);
      for (const [other, turn] of winding) forget(other, turn);
      yield* Scope.close(open.scope, Exit.void);
    });

  /**
   * The provider thread the harness will run on, keeping the thread's own
   * identity for it, and the turn to start there: on a new session when the
   * native resume fails, with the conversation the thread sent for that case.
   */
  const loadProviderThread = (
    session: ProviderAdapterV2SessionRuntime,
    turn: RunnerTurn,
    runtimePolicy: ProviderAdapterV2RuntimePolicy,
  ) => {
    const ensure = (existing: OrchestrationV2ProviderThread) =>
      session.ensureThread({
        threadId: input.threadId,
        modelSelection: turn.modelSelection,
        runtimePolicy,
        providerSessionId: session.providerSessionId,
        existingProviderThread: existing,
      });
    const loaded =
      turn.providerThread.nativeThreadRef === null
        ? Effect.map(ensure(turn.providerThread), (providerThread) => ({ providerThread, turn }))
        : session
            .resumeThread({
              providerThread: turn.providerThread,
              threadId: input.threadId,
              modelSelection: turn.modelSelection,
              runtimePolicy,
            })
            .pipe(
              Effect.map((providerThread) => ({ providerThread, turn })),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    "native resume failed; starting a fresh session",
                    Cause.pretty(cause),
                  );
                  yield* input.emit(
                    log(
                      turn.runId,
                      "warning",
                      `native resume failed; starting a fresh session: ${causeText(cause)}`,
                    ),
                  );
                  // A thread from before #653 sent no conversation: the message alone it is.
                  const fresh: RunnerTurn = onFreshSession(
                    turn,
                    turn.freshSessionText ?? turn.message.text,
                  );
                  return { providerThread: yield* ensure(fresh.providerThread), turn: fresh };
                }),
              ),
            );
    return Effect.map(loaded, (loaded) => ({
      turn: loaded.turn,
      providerThread: { ...loaded.providerThread, id: turn.providerThread.id },
    }));
  };

  /**
   * Has the agent take in the main `state`'s turn start found conflicting
   * (`resolveMainConflict`), in provider turns of its run before its own, then
   * brings dependencies in step with what it took in. Answers false when the
   * thread stopped the run meanwhile: it already ended it.
   */
  const resolveBeforeTurn = (state: Turn, conflict: MainConflict, current: RunnerDrive) =>
    Effect.gen(function* () {
      const runId = state.turn.runId;
      const held: Held = { waiting: null };
      finishing.set(runId, held);
      let attempts = 0;
      const merged = yield* resolveMainConflict({
        runId,
        conflict,
        drive: current,
        emit: input.emit,
        resolve: (prompt) => continueTurn(runId, state, prompt, "sync", ++attempts),
        stopped: Effect.sync(() => held.stopped === true),
      });
      // One step with the check, so a stop lands either on `held` or on the turn itself.
      const goOn = yield* ordered.withPermits(1)(
        Effect.sync(() => {
          finishing.delete(runId);
          if (held.stopped === true) {
            // A merge step still running stays tracked, so it's interrupted once the harness
            // names it and the next turn winds it down; the run's own turn never reaches it.
            forget(runId, state);
            if (runningRunId === runId) runningRunId = null;
            return false;
          }
          // Its merge steps ran as their own attempts; the turn's own goes on as itself.
          turns.set(runId, state);
          return true;
        }),
      );
      // A merged lockfile is installed on heavy; light runs move up when they use a package.
      if (goOn && merged) yield* preparing.withPermits(1)(prepareDependencies(runId));
      return goOn;
    });

  const run = (
    turn: RunnerTurn,
    modelToken: string,
    access: DriveAccess | null,
    sessionAccess: SessionAccess | null,
    secretsAccess: SecretsAccess | null,
    state: Turn,
  ) => {
    // The session may spawn its CLI below; what it writes from here on is this turn's.
    const stderrMark = input.stderr?.mark() ?? 0;
    latestStderr = stderrMark;
    return Effect.gen(function* () {
      const adapter = input.adapters.get(turn.modelSelection.instanceId);
      if (adapter === undefined) {
        return yield* new RunnerTurnError({
          message: `${turn.modelSelection.instanceId} is not available on this machine.`,
        });
      }
      const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
        cwd: input.cwd,
      };
      latestRunId = turn.runId;
      classified.clear();
      latestTraceId = turn.traceId;
      // `/drives` and the context tool read one version of everything for the whole
      // turn; the view is taken while the checkout and session load.
      const pinning =
        access === null || input.pinDrives === undefined
          ? null
          : yield* Effect.forkChild(input.pinDrives(access));
      state.pinnedContext = pinning;
      // The harness starts in the thread's branch, as the drive last saved it, with its dependencies.
      const opened = access === null ? null : yield* driveFor(access);
      const prepared = yield* preparing.withPermits(1)(
        Effect.gen(function* () {
          const drive =
            opened !== null && access !== null
              ? yield* opened
                  .prepare(
                    access.remoteToken,
                    access.author,
                    access.instructions,
                    // A turn continuing one a lost machine ran keeps the base it had.
                    turn.restartContinuationOfRunId === undefined
                      ? (turn.appThread.pullRequests ?? [])
                      : [],
                  )
                  .pipe(
                    Effect.mapError((error) =>
                      isInstructionsError(error) ? error : drivePrepareError(error),
                    ),
                  )
              : null;
          yield* prepareDependencies(turn.runId);
          // Edits the thread made inside dependency trees, once the trees are rebuilt (#490).
          if (opened !== null && input.machineClass !== "light") {
            yield* opened.restoreDependencyEdits;
          }
          // From the first turn on, changes stream into the drive as they happen (#493).
          if (opened !== null && watching !== opened) {
            watching = opened;
            yield* watchChanges({
              interval: WATCH_INTERVAL,
              changed: opened.changed,
              save: opened.saveNow.pipe(Effect.mapError(saveFailureReason)),
              notice: driveNotice,
            }).pipe(Effect.forkIn(scope));
          }
          const secrets =
            input.secrets === undefined
              ? 0
              : yield* input.secrets
                  .load(secretsAccess, {
                    notice: (message) =>
                      input.emit({ kind: "secrets.notice", runId: turn.runId, message }),
                    info: (message) => input.emit(log(turn.runId, "info", message)),
                    register: (secrets) =>
                      sessionAccess === null || input.registerSecrets === undefined
                        ? Effect.fail(
                            new SecretsRegisterError({
                              message: "this machine can't reach the thread to register them",
                            }),
                          )
                        : input.registerSecrets(sessionAccess.token, secrets),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new RunnerTurnError({
                          message: `This folder's secrets couldn't be registered to hide them from the model, so the turn stopped: ${error.message}. Try again.`,
                        }),
                    ),
                  );
          return { drive, secrets };
        }),
      );
      yield* input.useModelToken(modelToken).pipe(Effect.mapError(machineStateError));
      // The harness loads its session as last saved: on a new machine, from the store.
      if (input.sessions !== undefined && sessionAccess !== null) {
        yield* input.sessions.use(sessionAccess);
        yield* input.sessions.prepare(adapter.driver);
      }
      // Pasted screenshots and files, as the files the adapter points the harness at,
      // fetched while the session loads.
      const attachments =
        input.attachments === undefined || sessionAccess === null
          ? null
          : yield* Effect.forkChild(
              input.attachments
                .bring(sessionAccess.token, turn.message.attachments)
                // Its message says why, naming the turn's own files when they're the reason.
                .pipe(Effect.mapError((error) => new RunnerTurnError({ message: error.message }))),
            );
      // A turn already stopped never waits on, or restarts, the session the next one runs on.
      if (state.status !== "stopped") yield* windDown(adapter.instanceId, turn.runId);
      const session = yield* sessionFor(adapter, turn, runtimePolicy, {
        instructions: prepared.drive?.instructions ?? "",
        secrets: prepared.secrets,
      });
      const { providerThread, turn: starting } = yield* loadProviderThread(
        session,
        turn,
        runtimePolicy,
      );
      feedback.remember(session, providerThread);
      if (pinning !== null) yield* Fiber.join(pinning);
      if (attachments !== null) yield* Fiber.join(attachments);
      const started = yield* ordered.withPermits(1)(
        Effect.gen(function* () {
          // Stopped while the session loaded: the thread already ended the run.
          if (state.status === "stopped") {
            forget(turn.runId, state);
            return false;
          }
          state.status = "running";
          state.session = session;
          state.providerThread = providerThread;
          runningRunId = turn.runId;
          yield* reportUsage(turn.runId);
          yield* input.emit({
            kind: "turn.started",
            runId: turn.runId,
            providerSession: session.providerSession,
            providerThread,
          });
          for (const message of [...(prepared.drive?.notices ?? []), ...heldNotices]) {
            yield* input.emit({ kind: "drive.notice", runId: turn.runId, message });
          }
          heldNotices = [];
          return true;
        }),
      );
      if (!started) return;
      const conflict = prepared.drive?.mainConflict;
      if (conflict !== undefined && opened !== null) {
        if (!(yield* resolveBeforeTurn(state, conflict, opened))) return;
      }
      yield* session.startTurn({
        appThread: turn.appThread,
        threadId: input.threadId,
        runId: turn.runId,
        runOrdinal: turn.runOrdinal,
        providerTurnOrdinal: starting.providerTurnOrdinal,
        attemptId: turn.attemptId,
        rootNodeId: turn.rootNodeId,
        providerThread,
        message: starting.message,
        modelSelection: turn.modelSelection,
        runtimePolicy,
        ...(starting.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: starting.restartContinuationOfRunId }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        ordered.withPermits(1)(
          Effect.gen(function* () {
            yield* Effect.logError("turn failed to start", Cause.pretty(cause));
            forget(turn.runId, state);
            if (runningRunId === turn.runId) runningRunId = null;
            yield* input.emit(
              log(turn.runId, "error", failureLine("turn failed to start", cause, stderrMark)),
            );
            yield* input.emit({
              kind: "turn.failed",
              runId: turn.runId,
              message: failureMessage(cause),
            });
          }),
        ),
      ),
      Effect.annotateLogs({ traceId: turn.traceId, runId: turn.runId }),
    );
  };

  const start: RunnerTurns["start"] = ({
    turn,
    modelToken,
    drive: access = null,
    sessions: sessionAccess = null,
    secrets: secretsAccess = null,
  }) =>
    Effect.suspend(() => {
      if (taken.has(turn.runId)) return Effect.void;
      taken.add(turn.runId);
      const state: Turn = {
        turn,
        attemptId: turn.attemptId,
        status: "loading",
        session: null,
        providerThread: null,
        providerTurnId: null,
        ended: Deferred.makeUnsafe<void>(),
        sessionToken: sessionAccess?.token ?? null,
        steered: new Set(),
        steers: [],
        pinnedContext: null,
      };
      // The thread hands out one run at a time, so any other this machine
      // still runs is one it stopped, even when that `interrupt` never came.
      return keepOnly(turn.runId).pipe(
        Effect.andThen(Effect.sync(() => turns.set(turn.runId, state))),
        Effect.andThen(
          run(turn, modelToken, access, sessionAccess, secretsAccess, state).pipe(
            Effect.forkIn(scope),
          ),
        ),
        Effect.asVoid,
      );
    });

  const interrupt: RunnerTurns["interrupt"] = (runId) =>
    Effect.suspend(() => {
      // A merge the agent was resolving ends with the run; its files stay saved.
      const held = finishing.get(runId);
      if (held !== undefined) held.stopped = true;
      if (held?.waiting != null) Deferred.doneUnsafe(held.waiting, Effect.succeed(false));
      const turn = turns.get(runId);
      if (turn === undefined || turn.status === "stopped") return Effect.void;
      const wasRunning = turn.status === "running";
      turn.status = "stopped";
      // Before the harness names its turn, `track` interrupts once it does. The
      // harness may take seconds to stop; the socket meanwhile reads on.
      return wasRunning ? Effect.asVoid(Effect.forkIn(interruptNow(turn), scope)) : Effect.void;
    });

  const steer: RunnerTurns["steer"] = (runId, message) =>
    Effect.suspend(() => {
      const turn = turns.get(runId);
      if (turn === undefined || turn.status === "stopped") {
        // The turn ended here as the message came: the thread hears why it went unanswered.
        return input.emit(
          log(runId, "warning", "a message sent mid-turn arrived after the turn ended here"),
        );
      }
      if (turn.steered.has(message.messageId)) return Effect.void;
      turn.steered.add(message.messageId);
      turn.steers.push(message);
      return deliverSteers(turn);
    });

  const keepOnly: RunnerTurns["keepOnly"] = (runId) =>
    Effect.forEach(
      [...turns.keys()].filter((candidate) => candidate !== runId),
      interrupt,
      {
        discard: true,
      },
    );

  // Rows that stop being saved stop the turn that writes them, and say why.
  if (input.sessions !== undefined) {
    yield* Queue.take(input.sessions.failures).pipe(
      Effect.flatMap((message) =>
        Effect.gen(function* () {
          const runId = latestRunId;
          const live = runId === null ? undefined : turns.get(runId);
          if (runId === null || live === undefined || live.status === "stopped") {
            return yield* Effect.logWarning("session rows are not being saved", message);
          }
          yield* ordered.withPermits(1)(input.emit({ kind: "session.notice", runId, message }));
          yield* interrupt(runId);
        }),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
  }

  let idleIntervals = 0;
  yield* Effect.forever(
    Effect.sleep(USAGE_INTERVAL).pipe(
      Effect.andThen(
        ordered.withPermits(1)(
          Effect.suspend(() => {
            if (runningRunId !== null) {
              idleIntervals = 0;
              return reportUsage(runningRunId);
            }
            idleIntervals += 1;
            return idleIntervals % IDLE_USAGE_EVERY === 0 ? reportUsage(null) : Effect.void;
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkIn(scope));

  return {
    uploadFeedback: feedback.upload,
    start,
    interrupt,
    steer,
    pull,
    keepOnly,
    drain,
    taken: Effect.sync(() => [...taken]),
  } satisfies RunnerTurns;
});

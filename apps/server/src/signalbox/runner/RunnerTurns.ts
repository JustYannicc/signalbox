import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type {
  MachineUsage,
  RunnerItem,
  RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
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
import type * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
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
  type ProviderAdapterV2Shape,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";
import { stripUnservedToolOutputImageBytes } from "../../orchestration-v2/toolOutputImageBytes.ts";
import type { HarnessStderr } from "./harnessStderr.ts";
import type { RunnerDrive } from "./RunnerDrive.ts";
import type { RunnerSessions } from "./RunnerSessions.ts";
import { causeText, runnerLog } from "./runnerLog.ts";
import { FILE_CHANGING_ITEMS, finishDriveTurn } from "./RunnerTurnDrive.ts";
import { isUnmeasured } from "./RunnerUsage.ts";

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
 *
 * The harness's own session leaves the machine as it is written
 * (`RunnerSessions.ts`): it is restored before the harness loads it, an event
 * reporting something complete waits until the rows behind it are durable,
 * and a turn whose rows stop being saved is stopped. A turn that continues one
 * lost with its machine (`restartContinuationOfRunId`) resumes the restored
 * session natively.
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
  /**
   * Starts a turn, as `turn.start` hands it over. A run already started is
   * ignored, so the thread can repeat itself.
   */
  readonly start: (start: {
    readonly turn: RunnerTurn;
    readonly modelToken: string;
    readonly drive?: DriveAccess | null;
    readonly sessions?: SessionAccess | null;
  }) => Effect.Effect<void>;
  /** Stops `runId`, wherever it is: loading, or running on the harness. */
  readonly interrupt: (runId: RunId) => Effect.Effect<void>;
  /** Stops every turn but `runId`, the one the thread still considers live. */
  readonly keepOnly: (runId: RunId | null) => Effect.Effect<void>;
}

/** A run this machine was handed, until the harness ends its turn. */
interface Turn {
  readonly turn: RunnerTurn;
  readonly attemptId: RunAttemptId;
  status: "loading" | "running" | "stopped";
  session: ProviderAdapterV2SessionRuntime | null;
  providerThread: OrchestrationV2ProviderThread | null;
  providerTurnId: ProviderTurnId | null;
}

const encodeAdapterEvent = Schema.encodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event));

/** The failure text a thread may store: bounded and with credentials redacted. */
const failureMessage = (cause: Cause.Cause<unknown>) =>
  makeProviderFailure({ cause: Cause.squash(cause) }).message;

const USAGE_INTERVAL = "30 seconds";
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
  readonly adapters: ReadonlyMap<ProviderInstanceId, ProviderAdapterV2Shape>;
  /** The thread's working directory on this machine. */
  readonly cwd: string;
  /** Makes `token` the one the harnesses present to the ModelGateway. */
  readonly useModelToken: (token: string) => Effect.Effect<void, PlatformError.PlatformError>;
  /** The machine's usage so far (`RunnerUsage.ts`). */
  readonly usage: Effect.Effect<MachineUsage>;
  /** What the harness CLIs wrote to stderr, quoted in failure lines (`harnessStderr.ts`). */
  readonly stderr?: Pick<HarnessStderr, "mark" | "since">;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  /** The thread's drive, checked out in `cwd`. Absent: turns run in a plain directory. */
  readonly openDrive?: (access: DriveAccess) => Effect.Effect<RunnerDrive, never, Scope.Scope>;
  /** Where the harnesses' sessions are kept. Absent: they stay on this machine. */
  readonly sessions?: RunnerSessions;
}) {
  const scope = yield* Effect.scope;
  const logAnnotations = yield* References.CurrentLogAnnotations;
  const sessions = new Map<ProviderInstanceId, ProviderAdapterV2SessionRuntime>();
  const turns = new Map<RunId, Turn>();
  /** Runs this machine already took, so a repeated `turn.start` starts nothing. */
  const taken = new Set<RunId>();
  /** The run adapter events belong to: the latest one started. */
  let latestRunId: RunId | null = null;
  let latestTraceId: string | null = null;
  /** Where the latest run's stderr starts. */
  let latestStderr = 0;
  /** A failure line: the cause, then what the CLIs said on stderr since `mark`. */
  const failureLine = (what: string, cause: Cause.Cause<unknown>, mark: number) => {
    const stderr = input.stderr?.since(mark) ?? "";
    const text = causeText(cause);
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

  /** Emits the usage so far, unless the machine cannot measure any of it. */
  const reportUsage = (runId: RunId | null) =>
    Effect.flatMap(input.usage, (usage) =>
      isUnmeasured(usage) ? Effect.void : input.emit({ kind: "usage", runId, usage }),
    );
  /** The drive, opened by the first turn that names it; one per machine generation. */
  let drive: { readonly driveId: string; readonly drive: RunnerDrive } | null = null;
  /** Runs whose end is held until their files land, and the agent turn awaited for a conflict. */
  const finishing = new Map<RunId, { waiting: Deferred.Deferred<boolean> | null }>();
  /** Agent turns run to resolve a merge, by attempt, and their provider turns once named. */
  const mergeAttempts = new Set<RunAttemptId>();
  const mergeProviderTurns = new Set<ProviderTurnId>();

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
                    runnerLog(
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

  /** Learns each turn's native id, stops one asked to stop before then, and forgets ended ones. */
  const track = (event: ProviderAdapterV2Event) =>
    Effect.gen(function* () {
      if (event.type === "turn.terminal") {
        for (const [runId, turn] of turns) {
          if (turn.providerTurnId === event.providerTurnId) turns.delete(runId);
        }
        return;
      }
      if (event.type !== "provider_turn.updated") return;
      for (const turn of turns.values()) {
        if (turn.providerTurnId !== null || event.providerTurn.runAttemptId !== turn.attemptId) {
          continue;
        }
        turn.providerTurnId = event.providerTurn.id;
        if (turn.status === "stopped") yield* interruptNow(turn);
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

  /** Runs the agent once more in `runId`'s turn and answers whether that completed. */
  const continueTurn = (runId: RunId, state: Turn, prompt: string, attempt: number) =>
    Effect.gen(function* () {
      const held = finishing.get(runId);
      if (held === undefined || state.session === null || state.providerThread === null) {
        return false;
      }
      const ended = yield* Deferred.make<boolean>();
      const turn = state.turn;
      // Its own attempt: adapters name the provider turn, and Claude its prompt, after the attempt.
      const attemptId = RunAttemptId.make(`${turn.attemptId}:merge:${attempt}`);
      const continuation: Turn = { ...state, attemptId, status: "running", providerTurnId: null };
      held.waiting = ended;
      mergeAttempts.add(attemptId);
      turns.set(runId, continuation);
      yield* state.session
        .startTurn({
          appThread: turn.appThread,
          threadId: input.threadId,
          runId,
          runOrdinal: turn.runOrdinal,
          // Clear of the ordinals the thread gives its next runs.
          providerTurnOrdinal: turn.providerTurnOrdinal * 1000 + attempt,
          attemptId,
          rootNodeId: turn.rootNodeId,
          providerThread: state.providerThread,
          message: {
            ...turn.message,
            messageId: MessageId.make(`${turn.message.messageId}:merge:${attempt}`),
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
              if (turns.get(runId) === continuation) turns.delete(runId);
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
          turns.delete(runId);
        }
        if (waiting !== null) yield* Deferred.succeed(waiting, event.status === "completed");
        return true;
      }
      const held = finishing.get(runId);
      const state = turns.get(runId);
      if (held !== undefined || state === undefined || event.status !== "completed") {
        // Interrupted or failed: what the agent did is kept as an auto-save.
        yield* current.autosave;
        return false;
      }
      finishing.set(runId, { waiting: null });
      yield* track(event);
      let attempts = 0;
      yield* finishDriveTurn({
        runId,
        message: state.turn.message.text,
        drive: current,
        emit: input.emit,
        resolve: (prompt) => continueTurn(runId, state, prompt, ++attempts),
      }).pipe(
        Effect.andThen(deliver(event, runId)),
        Effect.ensuring(Effect.sync(() => finishing.delete(runId))),
        Effect.forkIn(scope),
      );
      return true;
    });

  const forward = (adapter: ProviderAdapterV2Shape, runtime: ProviderAdapterV2SessionRuntime) => {
    const instanceId = adapter.instanceId;
    const filterAssistant = makeAssistantStreamingFilter(
      DEFAULT_SERVER_SETTINGS.responseStreamingMode,
    );
    /** Sends `event` as `runId`'s; a held end goes out under its own run, whatever runs since. */
    const deliver = (event: ProviderAdapterV2Event, runId: RunId | null = latestRunId) =>
      Effect.gen(function* () {
        const delivered = filterAssistant(event, yield* Clock.currentTimeMillis);
        if (delivered === null || runId === null) return;
        // Complete only once the rows behind it would survive this machine.
        if (input.sessions !== undefined) yield* input.sessions.settle(adapter.driver, delivered);
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
          if (yield* holdForDrive(event, (held, runId) => deliver(held, runId))) return;
          yield* track(event);
          yield* deliver(event);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("provider event stream ended", Cause.pretty(cause)).pipe(
          Effect.andThen(
            input.emit(
              runnerLog(
                latestRunId,
                "error",
                failureLine("provider event stream ended", cause, latestStderr),
              ),
            ),
          ),
          withTrace(latestTraceId),
        ),
      ),
      // A session whose events ended is dead; the next turn opens a new one.
      Effect.ensuring(Effect.sync(() => sessions.delete(instanceId))),
    );
  };

  const sessionFor = (
    adapter: ProviderAdapterV2Shape,
    turn: RunnerTurn,
    runtimePolicy: ProviderAdapterV2RuntimePolicy,
  ) =>
    Effect.gen(function* () {
      const open = sessions.get(adapter.instanceId);
      if (open !== undefined) return open;
      const runtime = yield* adapter
        .openSession({
          threadId: input.threadId,
          providerSessionId: ProviderSessionId.make(
            `runner:${input.threadId}:${adapter.instanceId}`,
          ),
          modelSelection: turn.modelSelection,
          runtimePolicy,
        })
        .pipe(Scope.provide(scope));
      sessions.set(adapter.instanceId, runtime);
      yield* forward(adapter, runtime).pipe(Effect.forkIn(scope));
      return runtime;
    }).pipe(
      // The session outlives the turn that opened it, so its fibers don't carry that turn's trace.
      Effect.provideService(References.CurrentLogAnnotations, logAnnotations),
    );

  /** The provider thread the harness will run on, keeping the thread's own identity for it. */
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
        ? ensure(turn.providerThread)
        : session
            .resumeThread({
              providerThread: turn.providerThread,
              threadId: input.threadId,
              modelSelection: turn.modelSelection,
              runtimePolicy,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "native resume failed; starting a fresh session",
                  Cause.pretty(cause),
                ).pipe(
                  Effect.andThen(
                    input.emit(
                      runnerLog(
                        turn.runId,
                        "warning",
                        `native resume failed; starting a fresh session: ${causeText(cause)}`,
                      ),
                    ),
                  ),
                  Effect.andThen(ensure({ ...turn.providerThread, nativeThreadRef: null })),
                ),
              ),
            );
    return Effect.map(loaded, (providerThread) => ({
      ...providerThread,
      id: turn.providerThread.id,
    }));
  };

  const run = (
    turn: RunnerTurn,
    modelToken: string,
    access: DriveAccess | null,
    sessionAccess: SessionAccess | null,
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
      latestTraceId = turn.traceId;
      // The harness starts in the thread's branch, as the drive last saved it.
      const opened = access === null ? null : yield* driveFor(access);
      if (opened !== null) yield* opened.prepare;
      yield* input.useModelToken(modelToken);
      // The harness loads its session as last saved: on a new machine, from the store.
      if (input.sessions !== undefined && sessionAccess !== null) {
        yield* input.sessions.use(sessionAccess);
        yield* input.sessions.prepare(adapter.driver);
      }
      const session = yield* sessionFor(adapter, turn, runtimePolicy);
      const providerThread = yield* loadProviderThread(session, turn, runtimePolicy);
      const started = yield* ordered.withPermits(1)(
        Effect.gen(function* () {
          // Stopped while the session loaded: the thread already ended the run.
          if (state.status === "stopped") {
            turns.delete(turn.runId);
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
          return true;
        }),
      );
      if (!started) return;
      yield* session.startTurn({
        appThread: turn.appThread,
        threadId: input.threadId,
        runId: turn.runId,
        runOrdinal: turn.runOrdinal,
        providerTurnOrdinal: turn.providerTurnOrdinal,
        attemptId: turn.attemptId,
        rootNodeId: turn.rootNodeId,
        providerThread,
        message: turn.message,
        modelSelection: turn.modelSelection,
        runtimePolicy,
        ...(turn.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: turn.restartContinuationOfRunId }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        ordered.withPermits(1)(
          Effect.gen(function* () {
            yield* Effect.logError("turn failed to start", Cause.pretty(cause));
            turns.delete(turn.runId);
            if (runningRunId === turn.runId) runningRunId = null;
            yield* input.emit(
              runnerLog(
                turn.runId,
                "error",
                failureLine("turn failed to start", cause, stderrMark),
              ),
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
      };
      turns.set(turn.runId, state);
      return Effect.asVoid(
        run(turn, modelToken, access, sessionAccess, state).pipe(Effect.forkIn(scope)),
      );
    });

  const interrupt: RunnerTurns["interrupt"] = (runId) =>
    Effect.suspend(() => {
      // A merge the agent was resolving ends with the run; its files stay saved.
      const held = finishing.get(runId);
      if (held?.waiting != null) Deferred.doneUnsafe(held.waiting, Effect.succeed(false));
      const turn = turns.get(runId);
      if (turn === undefined || turn.status === "stopped") return Effect.void;
      const wasRunning = turn.status === "running";
      turn.status = "stopped";
      // Before the harness names its turn, `track` interrupts once it does.
      return wasRunning ? interruptNow(turn) : Effect.void;
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

  return { start, interrupt, keepOnly } satisfies RunnerTurns;
});

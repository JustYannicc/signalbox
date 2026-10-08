import type {
  MachineUsage,
  RunnerItem,
  RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
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
import { causeText, runnerLog } from "./runnerLog.ts";
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
 * The machine's usage goes out just before each `turn.started`, right after
 * each `turn.terminal`, and every half minute, and problems the Runner hits go
 * out as log lines, so a turn's diagnostic record holds both. The Runner's own
 * logs for a turn carry its trace id.
 */

export class RunnerTurnError extends Schema.TaggedError<RunnerTurnError>()("RunnerTurnError", {
  message: Schema.String,
}) {}

export interface RunnerTurns {
  /** Starts a turn. A run already started is ignored, so the thread can repeat itself. */
  readonly start: (turn: RunnerTurn, modelToken: string) => Effect.Effect<void>;
  /** Stops `runId`, wherever it is: loading, or running on the harness. */
  readonly interrupt: (runId: RunId) => Effect.Effect<void>;
  /** Stops every turn but `runId`, the one the thread still considers live. */
  readonly keepOnly: (runId: RunId | null) => Effect.Effect<void>;
}

/** A run this machine was handed, until the harness ends its turn. */
interface Turn {
  readonly runId: RunId;
  readonly traceId: string;
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
  /** The run on the harness, from its `turn.started` until its `turn.terminal`. */
  let runningRunId: RunId | null = null;
  // A run's usage and the items it brackets go out under one lock, so a
  // half-minute report never lands before a run's start or after its end.
  const ordered = yield* Semaphore.make(1);

  /** Emits the usage so far, unless the machine cannot measure any of it. */
  const reportUsage = (runId: RunId | null) =>
    Effect.flatMap(input.usage, (usage) =>
      isUnmeasured(usage) ? Effect.void : input.emit({ kind: "usage", runId, usage }),
    );

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
                      turn.runId,
                      "warning",
                      `interrupting the provider turn failed: ${causeText(cause)}`,
                    ),
                  ),
                ),
              ),
            ),
            withTrace(turn.traceId),
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

  const forward = (instanceId: ProviderInstanceId, runtime: ProviderAdapterV2SessionRuntime) => {
    const filterAssistant = makeAssistantStreamingFilter(
      DEFAULT_SERVER_SETTINGS.responseStreamingMode,
    );
    return runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          yield* track(event);
          const delivered = filterAssistant(event, yield* Clock.currentTimeMillis);
          if (delivered === null || latestRunId === null) return;
          const runId = latestRunId;
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
          yield* ordered.withPermits(1)(
            Effect.gen(function* () {
              yield* input.emit(item);
              if (runningRunId === runId) runningRunId = null;
              yield* reportUsage(runId);
            }),
          );
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
      yield* forward(adapter.instanceId, runtime).pipe(Effect.forkIn(scope));
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

  const run = (turn: RunnerTurn, modelToken: string, state: Turn) => {
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
      yield* input.useModelToken(modelToken);
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

  const start: RunnerTurns["start"] = (turn, modelToken) =>
    Effect.suspend(() => {
      if (taken.has(turn.runId)) return Effect.void;
      taken.add(turn.runId);
      const state: Turn = {
        runId: turn.runId,
        traceId: turn.traceId,
        attemptId: turn.attemptId,
        status: "loading",
        session: null,
        providerThread: null,
        providerTurnId: null,
      };
      turns.set(turn.runId, state);
      return Effect.asVoid(run(turn, modelToken, state).pipe(Effect.forkIn(scope)));
    });

  const interrupt: RunnerTurns["interrupt"] = (runId) =>
    Effect.suspend(() => {
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

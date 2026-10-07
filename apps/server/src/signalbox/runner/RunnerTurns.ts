import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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

/**
 * Drives one thread's turns through the provider adapters, the way the
 * server's turn start does for a self-hosted thread: one adapter session per
 * provider, the thread's provider thread ensured (first turn) or resumed
 * natively (later turns, falling back to a fresh one), then `startTurn`.
 * Everything that happens is reported through `emit` as Runner items, in
 * order. Adapter events pass the same filters the server applies before it
 * stores them (assistant streaming cadence, tool output images), then go out
 * in their JSON encoding.
 */

export class RunnerTurnError extends Schema.TaggedError<RunnerTurnError>()("RunnerTurnError", {
  message: Schema.String,
}) {}

export interface RunnerTurns {
  /** Starts a turn. A run already started is ignored, so the thread can repeat itself. */
  readonly start: (turn: RunnerTurn) => Effect.Effect<void>;
  /** Stops `runId`, wherever it is: loading, or running on the harness. */
  readonly interrupt: (runId: RunId) => Effect.Effect<void>;
  /** Stops every turn but `runId`, the one the thread still considers live. */
  readonly keepOnly: (runId: RunId | null) => Effect.Effect<void>;
}

/** A run this machine was handed, until the harness ends its turn. */
interface Turn {
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

export const makeRunnerTurns = Effect.fn("makeRunnerTurns")(function* (input: {
  readonly threadId: ThreadId;
  readonly adapters: ReadonlyMap<ProviderInstanceId, ProviderAdapterV2Shape>;
  /** The thread's working directory on this machine. */
  readonly cwd: string;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
}) {
  const scope = yield* Effect.scope;
  const sessions = new Map<ProviderInstanceId, ProviderAdapterV2SessionRuntime>();
  const turns = new Map<RunId, Turn>();
  /** Runs this machine already took, so a repeated `turn.start` starts nothing. */
  const taken = new Set<RunId>();
  /** The run adapter events belong to: the latest one started. */
  let latestRunId: RunId | null = null;

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
              Effect.logWarning("interrupting the provider turn failed", Cause.pretty(cause)),
            ),
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
          const stored =
            delivered.type === "turn_item.updated"
              ? { ...delivered, turnItem: stripUnservedToolOutputImageBytes(delivered.turnItem) }
              : delivered;
          yield* input.emit({
            kind: "provider",
            runId: latestRunId,
            event: encodeAdapterEvent(stored) as Record<string, unknown>,
          });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("provider event stream ended", Cause.pretty(cause)),
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
    });

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
                ).pipe(Effect.andThen(ensure({ ...turn.providerThread, nativeThreadRef: null }))),
              ),
            );
    return Effect.map(loaded, (providerThread) => ({
      ...providerThread,
      id: turn.providerThread.id,
    }));
  };

  const run = (turn: RunnerTurn, state: Turn) =>
    Effect.gen(function* () {
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
      const session = yield* sessionFor(adapter, turn, runtimePolicy);
      const providerThread = yield* loadProviderThread(session, turn, runtimePolicy);
      // Stopped while the session loaded: the thread already ended the run.
      if (state.status === "stopped") {
        turns.delete(turn.runId);
        return;
      }
      state.status = "running";
      state.session = session;
      state.providerThread = providerThread;
      yield* input.emit({
        kind: "turn.started",
        runId: turn.runId,
        providerSession: session.providerSession,
        providerThread,
      });
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
        Effect.gen(function* () {
          yield* Effect.logError("turn failed to start", Cause.pretty(cause));
          turns.delete(turn.runId);
          yield* input.emit({
            kind: "turn.failed",
            runId: turn.runId,
            message: failureMessage(cause),
          });
        }),
      ),
    );

  const start: RunnerTurns["start"] = (turn) =>
    Effect.suspend(() => {
      if (taken.has(turn.runId)) return Effect.void;
      taken.add(turn.runId);
      const state: Turn = {
        attemptId: turn.attemptId,
        status: "loading",
        session: null,
        providerThread: null,
        providerTurnId: null,
      };
      turns.set(turn.runId, state);
      return Effect.asVoid(run(turn, state).pipe(Effect.forkIn(scope)));
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

  return { start, interrupt, keepOnly } satisfies RunnerTurns;
});

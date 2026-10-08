import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
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
import type { RunnerDrive } from "./RunnerDrive.ts";
import { FILE_CHANGING_ITEMS, finishDriveTurn } from "./RunnerTurnDrive.ts";

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
 */

export class RunnerTurnError extends Schema.TaggedError<RunnerTurnError>()("RunnerTurnError", {
  message: Schema.String,
}) {}

export interface RunnerTurns {
  /** Starts a turn. A run already started is ignored, so the thread can repeat itself. */
  readonly start: (
    turn: RunnerTurn,
    modelToken: string,
    drive?: DriveAccess | null,
  ) => Effect.Effect<void>;
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

export const makeRunnerTurns = Effect.fn("makeRunnerTurns")(function* (input: {
  readonly threadId: ThreadId;
  readonly adapters: ReadonlyMap<ProviderInstanceId, ProviderAdapterV2Shape>;
  /** The thread's working directory on this machine. */
  readonly cwd: string;
  /** Makes `token` the one the harnesses present to the ModelGateway. */
  readonly useModelToken: (token: string) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  /** The thread's drive, checked out in `cwd`. Absent: turns run in a plain directory. */
  readonly openDrive?: (access: DriveAccess) => Effect.Effect<RunnerDrive, never, Scope.Scope>;
}) {
  const scope = yield* Effect.scope;
  const sessions = new Map<ProviderInstanceId, ProviderAdapterV2SessionRuntime>();
  const turns = new Map<RunId, Turn>();
  /** Runs this machine already took, so a repeated `turn.start` starts nothing. */
  const taken = new Set<RunId>();
  /** The run adapter events belong to: the latest one started. */
  let latestRunId: RunId | null = null;
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

  const forward = (instanceId: ProviderInstanceId, runtime: ProviderAdapterV2SessionRuntime) => {
    const filterAssistant = makeAssistantStreamingFilter(
      DEFAULT_SERVER_SETTINGS.responseStreamingMode,
    );
    /** Sends `event` as `runId`'s; a held end goes out under its own run, whatever runs since. */
    const deliver = (event: ProviderAdapterV2Event, runId: RunId | null = latestRunId) =>
      Effect.gen(function* () {
        const delivered = filterAssistant(event, yield* Clock.currentTimeMillis);
        if (delivered === null || runId === null) return;
        const stored =
          delivered.type === "turn_item.updated"
            ? { ...delivered, turnItem: stripUnservedToolOutputImageBytes(delivered.turnItem) }
            : delivered;
        yield* input.emit({
          kind: "provider",
          runId,
          event: encodeAdapterEvent(stored) as Record<string, unknown>,
        });
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

  const run = (turn: RunnerTurn, modelToken: string, access: DriveAccess | null, state: Turn) =>
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
      // The harness starts in the thread's branch, as the drive last saved it.
      const opened = access === null ? null : yield* driveFor(access);
      if (opened !== null) yield* opened.prepare;
      yield* input.useModelToken(modelToken);
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

  const start: RunnerTurns["start"] = (turn, modelToken, access = null) =>
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
      return Effect.asVoid(run(turn, modelToken, access, state).pipe(Effect.forkIn(scope)));
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

  return { start, interrupt, keepOnly } satisfies RunnerTurns;
});

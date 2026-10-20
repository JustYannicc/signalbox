import { RunnerTurn, type RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

import { HarnessError, type HarnessOpenInput } from "../Harness.ts";
import { nativeTurnThreadLoad } from "../HarnessThreadLoad.ts";
import { threadMatches } from "./checkpoint.ts";
import type { ActiveTurn, TurnState } from "./state.ts";

const encodeTurn = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));

export const makeTurn = ({
  input,
  runtime,
  state,
  output,
  lock,
  scope,
  check,
  poison,
}: {
  readonly input: HarnessOpenInput;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly state: TurnState;
  readonly output: Queue.Queue<RunnerItem, HarnessError | Cause.Done>;
  readonly lock: Semaphore.Semaphore;
  readonly scope: Scope.Scope;
  readonly check: (operation: "turn") => Effect.Effect<void, HarnessError>;
  readonly poison: (error: HarnessError) => Effect.Effect<void>;
}) => {
  let highestOrdinal = 0;
  const recent = new Map<
    string,
    { fingerprint: string; started: Deferred.Deferred<void, HarnessError> }
  >();
  const start = (current: ActiveTurn) =>
    Effect.gen(function* () {
      const turn = current.input;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* check("turn");
          if (state.providerThread === undefined) {
            const load = nativeTurnThreadLoad(turn, input.session, runtime.providerSessionId);
            state.providerThread = yield* (
              load.method === "ensureThread"
                ? runtime.ensureThread(load.input)
                : runtime.resumeThread(load.input)
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new HarnessError({
                    operation: "turn",
                    message: "Provider thread could not be loaded.",
                    cause,
                  }),
              ),
            );
          }
          if (
            !threadMatches(state.providerThread, input) ||
            state.providerThread.id !== turn.providerThread.id ||
            state.providerThread.driver !== runtime.driver
          ) {
            return yield* Effect.fail(
              new HarnessError({
                operation: "turn",
                message: "Loaded provider thread identity does not match.",
              }),
            );
          }
          current.providerThread = state.providerThread;
          yield* Queue.offer(output, {
            kind: "turn.started",
            runId: turn.runId,
            ...(turn.preparationGeneration === undefined
              ? {}
              : { preparationGeneration: turn.preparationGeneration }),
            providerSession: runtime.providerSession,
            providerThread: state.providerThread,
          });
          yield* Deferred.succeed(current.began, undefined);
        }),
      );
      yield* runtime
        .startTurn({
          appThread: turn.appThread,
          threadId: turn.threadId,
          runId: turn.runId,
          runOrdinal: turn.runOrdinal,
          providerTurnOrdinal: turn.providerTurnOrdinal,
          attemptId: turn.attemptId,
          rootNodeId: turn.rootNodeId,
          providerThread: current.providerThread,
          message: turn.message,
          modelSelection: turn.modelSelection,
          runtimePolicy: {
            ...input.session.runtimePolicy,
            runtimeMode: turn.runtimeMode,
            interactionMode: turn.interactionMode,
          },
          ...(turn.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuationOfRunId: turn.restartContinuationOfRunId }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "turn",
                message: "Provider turn could not be started.",
                cause,
              }),
          ),
        );
    }).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) {
            const error = new HarnessError({
              operation: "turn",
              message: "Provider turn start failed.",
              cause: exit.cause,
            });
            yield* poison(error);
            yield* Deferred.fail(current.began, error);
            yield* Deferred.fail(current.started, error);
          } else yield* Deferred.succeed(current.started, undefined);
        }),
      ),
    );
  return (turn: RunnerTurn) =>
    Effect.gen(function* () {
      const fingerprint = yield* encodeTurn(turn).pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Turn input encoding failed.",
              cause,
            }),
        ),
      );
      const started = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* check("turn");
          const prior = recent.get(turn.runId);
          if (prior !== undefined) {
            if (prior.fingerprint !== fingerprint)
              return yield* Effect.fail(
                new HarnessError({
                  operation: "turn",
                  message: "Duplicate start conflicts with the accepted turn.",
                }),
              );
            return prior.started;
          }
          if (
            state.active !== undefined ||
            turn.runOrdinal <= highestOrdinal ||
            turn.threadId !== input.session.threadId ||
            turn.appThread.id !== turn.threadId ||
            turn.modelSelection.instanceId !== runtime.instanceId ||
            !threadMatches(turn.providerThread, input) ||
            turn.providerThread.driver !== runtime.driver ||
            (state.providerThread !== undefined &&
              state.providerThread.id !== turn.providerThread.id)
          ) {
            return yield* Effect.fail(
              new HarnessError({
                operation: "turn",
                message:
                  "Turn is stale, conflicts with active work, or belongs to another session.",
              }),
            );
          }
          const current: ActiveTurn = {
            input: turn,
            providerThread: turn.providerThread,
            began: yield* Deferred.make<void, HarnessError>(),
            started: yield* Deferred.make<void, HarnessError>(),
            nativeTurn: undefined,
            interruptRequested: false,
            interruptApplied: false,
            requests: new Map(),
            answered: new Set(),
            steered: new Set(),
          };
          state.active = current;
          highestOrdinal = turn.runOrdinal;
          recent.set(turn.runId, { fingerprint, started: current.started });
          if (recent.size > 128) recent.delete(recent.keys().next().value!);
          yield* Effect.forkIn(Effect.interruptible(start(current)), scope);
          return current.started;
        }).pipe(Effect.uninterruptible),
      );
      yield* Deferred.await(started);
    });
};

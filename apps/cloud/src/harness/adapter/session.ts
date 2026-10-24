import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2RuntimeRequest, RunId } from "@t3tools/contracts";
import {
  logProviderEventLatency,
  providerEventLatencyTraceFor,
} from "@t3tools/provider-core/server/ProviderEventLatencyTrace";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { HarnessError, type HarnessOpenInput, type HarnessSession } from "../Harness.ts";
import { type HarnessRuntimeReporter } from "../HarnessProcessLifetime.ts";
import { checkpointThreadLoad } from "../HarnessThreadLoad.ts";
import { saveCheckpoint, saveComputer, threadMatches, validateOpen } from "./checkpoint.ts";
import { applyInterrupt, controlTurn } from "./controls.ts";
import { belongsToTurn, type TurnState } from "./state.ts";
import {
  cancelRequests,
  requestEvent,
  requestBelongsToSession,
  retainRequest,
} from "./requestState.ts";
import { makeTurn } from "./turns.ts";
import { makeAdapterFailure } from "./failure.ts";
import type { ActiveTurn } from "./state.ts";

const isHarnessError = Schema.is(HarnessError);
const encodeEventJson = Schema.encodeEffect(Schema.toCodecJson(ProviderAdapterV2Event));
const eventRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

export const openAdapterSession = (
  original: HarnessOpenInput,
  createRuntime: (
    input: HarnessOpenInput,
    reporter: HarnessRuntimeReporter,
  ) => Effect.Effect<
    ProviderAdapterV2SessionRuntime,
    HarnessError | ProviderAdapterV2Error,
    Scope.Scope
  >,
): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const input = yield* validateOpen(original);
    const scope = yield* Scope.fork(yield* Scope.Scope);
    return yield* Effect.gen(function* () {
      const output = yield* Queue.unbounded<RunnerItem, HarnessError | Cause.Done>();
      const lock = yield* Semaphore.make(1);
      let disposed = false;
      let closing = false;
      const requests = new Map<string, OrchestrationV2RuntimeRequest>(
        input.checkpoint?.snapshot.runtimeRequests.map((request) => [request.id, request]),
      );
      const state: TurnState = {
        active: undefined,
        last: undefined,
        providerThread: undefined,
        revision: undefined,
      };
      const clock = yield* Clock.Clock;
      const failure = makeAdapterFailure(output, state, () => clock.currentTimeMillisUnsafe());
      const poison = (error: HarnessError) =>
        Effect.sync(() => {
          if (!closing) failure.record(error);
        });
      // Runtime finalizers drain the process's last reports before this sink closes.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposed = true;
        }).pipe(Effect.andThen(Queue.end(output)), Effect.asVoid),
      );
      const runtime = yield* createRuntime(input, failure.reporter).pipe(
        Effect.mapError((cause) =>
          isHarnessError(cause)
            ? cause
            : new HarnessError({
                operation: "open",
                message: "Provider could not be opened.",
                cause,
              }),
        ),
      );
      if (
        runtime.providerSessionId !== input.session.providerSessionId ||
        runtime.providerSession.id !== input.session.providerSessionId ||
        runtime.instanceId !== input.session.modelSelection.instanceId ||
        runtime.providerSession.providerInstanceId !== runtime.instanceId ||
        runtime.providerSession.driver !== runtime.driver ||
        (input.checkpoint !== undefined &&
          input.checkpoint.providerSession.driver !== runtime.driver)
      ) {
        return yield* Effect.fail(
          new HarnessError({
            operation: "open",
            message: "Provider session identity does not match.",
          }),
        );
      }
      if (input.checkpoint !== undefined) {
        const existing = input.checkpoint.snapshot.providerThread;
        state.providerThread = yield* runtime
          .resumeThread(checkpointThreadLoad(input.checkpoint, input.session).input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError({
                  operation: "open",
                  message: "Native checkpoint resume failed.",
                  cause,
                }),
            ),
          );
        if (
          !threadMatches(state.providerThread, input) ||
          state.providerThread.id !== existing.id ||
          state.providerThread.driver !== runtime.driver ||
          state.providerThread.nativeThreadRef?.nativeId !== existing.nativeThreadRef?.nativeId
        ) {
          return yield* Effect.fail(
            new HarnessError({
              operation: "open",
              message: "Native resume changed thread identity.",
            }),
          );
        }
      }
      const check = (operation: HarnessError["operation"]) =>
        Effect.suspend(() =>
          failure.current !== undefined
            ? Effect.fail(failure.current)
            : disposed || closing
              ? Effect.fail(new HarnessError({ operation, message: "Harness is disposed." }))
              : Effect.void,
        );
      const checkpoint = (operation: "events" | "export") =>
        Effect.gen(function* () {
          yield* check(operation);
          if (state.providerThread === undefined) {
            return yield* Effect.fail(
              new HarnessError({ operation, message: "No provider thread has been loaded." }),
            );
          }
          const saved = yield* saveCheckpoint(
            input,
            runtime,
            state.providerThread,
            operation,
            requests,
            () => check(operation),
            failure.signal,
          );
          yield* check(operation);
          state.providerThread = saved.snapshot.providerThread;
          state.revision = saved.revision;
          return saved;
        });
      const publish = (event: ProviderAdapterV2Event, runId: RunId, completed?: ActiveTurn) =>
        encodeEventJson(event).pipe(
          Effect.flatMap(eventRecord),
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "events",
                message: "Provider event encoding failed.",
                cause,
              }),
          ),
          Effect.flatMap((encoded) =>
            Effect.gen(function* () {
              const forwarded = yield* Effect.sync(() => {
                if (disposed || closing || failure.current !== undefined) return false;
                if (completed !== undefined) {
                  state.last = completed;
                  state.active = undefined;
                }
                return Queue.offerUnsafe(output, { kind: "provider", runId, event: encoded });
              });
              if (!forwarded) return;
              const trace = providerEventLatencyTraceFor(event);
              if (trace !== undefined) {
                yield* logProviderEventLatency("runner.host-forward", {
                  ...trace,
                  runId,
                  threadId: input.session.threadId,
                  providerSessionId: input.session.providerSessionId,
                });
              }
            }),
          ),
        );
      const onEvent = (event: ProviderAdapterV2Event) =>
        Effect.gen(function* () {
          const current = state.active ?? state.last;
          if (current === undefined) return;
          if (event.type === "turn.terminal" && state.active !== current) return;
          yield* Deferred.await(current.began);
          if (event.type === "turn.terminal") yield* Deferred.await(current.started);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (
                disposed ||
                closing ||
                failure.current !== undefined ||
                (state.active ?? state.last) !== current ||
                event.driver !== runtime.driver ||
                !belongsToTurn(event, current)
              )
                return;
              if (event.type === "turn_item.updated") {
                current.nextItemOrdinal = Math.max(
                  current.nextItemOrdinal,
                  event.turnItem.ordinal + 1,
                );
              }
              if (event.type === "provider_thread.updated") {
                state.providerThread = current.providerThread = event.providerThread;
              }
              if (event.type === "provider_turn.updated") {
                current.nativeTurn = event.providerTurn;
                if (state.active === current) yield* applyInterrupt(runtime, current);
              }
              if (event.type === "runtime_request.updated") {
                if (
                  (state.active !== current &&
                    event.runtimeRequest.status === "pending" &&
                    event.runtimeRequest.responseCapability.type === "live") ||
                  !requestBelongsToSession(event.runtimeRequest, input, runtime.driver) ||
                  !retainRequest(requests, event.runtimeRequest)
                )
                  return;
                if (
                  current.requests.size >= 128 &&
                  !current.requests.has(event.runtimeRequest.id)
                ) {
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "events",
                      message: "Pending runtime request limit reached.",
                    }),
                  );
                }
                if (
                  event.runtimeRequest.status === "pending" &&
                  !current.answered.has(event.runtimeRequest.id)
                )
                  current.requests.set(event.runtimeRequest.id, event.runtimeRequest);
                else current.requests.delete(event.runtimeRequest.id);
              }
              if (event.type === "turn.terminal") {
                for (const request of cancelRequests(current, requests, yield* DateTime.now))
                  yield* publish(requestEvent(request, current), current.input.runId);
                // Computer owns the revision. Runner drive changes require real Drive evidence.
                yield* check("events");
                const revision = yield* saveComputer(input, "events", failure.signal);
                yield* check("events");
                state.revision = revision;
              }
              // One process serves several turns. Only unpublished work belongs to a later
              // shutdown omission; publishing the terminal ends this turn's failure boundary.
              yield* publish(
                event,
                current.input.runId,
                event.type === "turn.terminal" ? current : undefined,
              );
            }),
          );
        });
      const subscription =
        runtime.subscribeEvents === undefined ? undefined : yield* runtime.subscribeEvents;
      if (subscription !== undefined) yield* Effect.addFinalizer(() => subscription.close);
      yield* (subscription?.events ?? runtime.events).pipe(
        Stream.runForEach(onEvent),
        Effect.andThen(
          Effect.fail(
            new HarnessError({
              operation: "events",
              message: "Provider event stream ended.",
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          disposed
            ? Effect.void
            : poison(
                new HarnessError({
                  operation: "events",
                  message: "Provider event stream failed.",
                  cause,
                }),
              ),
        ),
        Effect.forkIn(scope),
      );
      const turn = makeTurn({ input, runtime, state, output, lock, scope, check, poison });
      const inScope = <A>(
        operation: "control" | "export",
        effect: Effect.Effect<A, HarnessError>,
      ) =>
        check(operation).pipe(
          Effect.andThen(effect.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join))),
        );
      const markClosing = Effect.gen(function* () {
        // Closing blocks new work while finalizers can still report failures.
        closing = true;
        if (state.active !== undefined) {
          const error = new HarnessError({
            operation: "dispose",
            message: "Harness was disposed during an active turn.",
          });
          yield* Deferred.fail(state.active.began, error);
          yield* Deferred.fail(state.active.started, error);
        }
      });
      const close = yield* Effect.cached(
        markClosing.pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.catchCause((cause) =>
            Effect.fail(
              new HarnessError({
                operation: "dispose",
                message: "Provider scope cleanup failed.",
                cause,
              }),
            ),
          ),
          Effect.uninterruptible,
        ),
      );
      const dispose = close.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            failure.shutdown === undefined ? Effect.void : Effect.fail(failure.shutdown),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => markClosing);
      return {
        release: input.release,
        get providerSession() {
          return runtime.providerSession;
        },
        events: Stream.fromQueue(output),
        turn,
        control: (control) =>
          inScope(
            "control",
            lock.withPermits(1)(
              Effect.gen(function* () {
                yield* check("control");
                if (state.active === undefined)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "control",
                      message: "No turn is active.",
                    }),
                  );
                const resolved = yield* controlTurn(runtime, state.active, control);
                if (resolved !== undefined && retainRequest(requests, resolved)) {
                  yield* publish(requestEvent(resolved, state.active), state.active.input.runId);
                }
              }),
            ),
          ),
        export: () =>
          inScope(
            "export",
            lock.withPermits(1)(
              Effect.gen(function* () {
                yield* check("export");
                if (state.active !== undefined)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "export",
                      message: "Turn is still active.",
                    }),
                  );
                return yield* checkpoint("export");
              }),
            ),
          ),
        dispose,
      } satisfies HarnessSession;
    }).pipe(
      Scope.provide(scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    );
  });

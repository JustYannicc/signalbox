import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
  type RunnerItem,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { HarnessError, type HarnessCheckpoint } from "../harness/Harness.ts";
import type { HarnessHostSession, TurnAccess } from "../harness/HarnessSessionHost.ts";
import type { Actor } from "./ThreadAccess.ts";
import { createHarnessContinuationPublisher } from "./HarnessContinuationPublisher.ts";
import { ThreadEngine } from "./ThreadEngine.ts";
import { ThreadStore } from "./ThreadStore.ts";
import { ThreadRunner, type RunnerWork } from "./runner/ThreadRunner.ts";

const failed = (message: string, cause?: unknown) =>
  new HarnessError({ operation: "events", message, ...(cause === undefined ? {} : { cause }) });

/** The canonical Runner owns turns; the facet supplies its native session and live grants. */
export const createThreadHarnessHost = <G>(options: {
  readonly threadId: ThreadId;
  readonly hello: Pick<
    RunnerHello,
    "threadId" | "generation" | "token" | "machineId" | "imageVersion"
  >;
  readonly actor: Effect.Effect<Actor, HarnessError>;
  readonly access: (work: RunnerWork) => Effect.Effect<TurnAccess<G>, HarnessError>;
  readonly persistCheckpoint: (
    checkpoint: HarnessCheckpoint,
    turn: RunnerTurn,
  ) => Effect.Effect<void, HarnessError>;
}) =>
  Effect.gen(function* () {
    const runner = yield* ThreadRunner;
    const engine = yield* ThreadEngine;
    const store = yield* ThreadStore;
    if (options.hello.threadId !== options.threadId)
      return yield* failed("A facet binding must connect to its own thread.");
    let connection: number | undefined;
    let sequence = 0;
    let attached = false;
    let brokenError: HarnessError | undefined;
    const broken = yield* Deferred.make<never, HarnessError>();
    const lock = yield* Semaphore.make(1);
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const currentActor = Effect.gen(function* () {
      if (brokenError !== undefined) return yield* brokenError;
      const actor = yield* options.actor;
      const owner = yield* store.owner.pipe(
        Effect.mapError((cause) => failed("Could not read the thread publisher owner.", cause)),
      );
      if (
        owner?.userId !== actor.userId ||
        !(yield* engine.canSee(actor)) ||
        (yield* runner.leaseToken(options.hello.generation, options.hello.token)) === null
      )
        return yield* failed("The facet no longer owns this thread's Runner lease.");
      const lease = yield* store.machine.pipe(
        Effect.mapError((cause) => failed("Could not read the facet's Runner lease.", cause)),
      );
      if (
        lease.generation !== options.hello.generation ||
        (connection !== undefined && lease.connection !== connection)
      )
        return yield* failed("Another Runner connection replaced this facet.");
      return actor;
    });
    const continuations = yield* createHarnessContinuationPublisher({
      authorize: (request) =>
        request.threadId === options.threadId
          ? currentActor
          : Effect.fail(failed("A facet cannot publish a continuation to another thread.")),
    });
    const batch = (items: ReadonlyArray<RunnerItem>) =>
      Effect.gen(function* () {
        const result = yield* runner.batch({
          generation: options.hello.generation,
          sequence: sequence + 1,
          items,
        });
        if (result._tag !== "ack" || result.sequence !== sequence + 1)
          return yield* failed("The thread did not commit the facet's Runner batch.", result);
        sequence = result.sequence;
      });
    yield* Scope.provide(
      Effect.addFinalizer(() =>
        Effect.suspend(() =>
          connection === undefined
            ? Effect.void
            : runner.disconnected({
                generation: options.hello.generation,
                connection,
                detail: "Harness facet binding closed.",
              }),
        ),
      ),
      scope,
    );

    return {
      authorize: currentActor,
      continuations,
      failure: Deferred.await(broken),
      attach: (session: HarnessHostSession<G>) =>
        Effect.gen(function* () {
          if (attached) return yield* failed("A Runner binding already has a native session.");
          attached = true;
          yield* currentActor;
          const welcome = yield* runner.hello({
            ...options.hello,
            type: "hello",
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            lastAckedSequence: 0,
            takenRunIds: [],
            steers: true,
            runtimeResponses: true,
          });
          if (welcome._tag === "refused") return yield* failed(welcome.message);
          if (welcome.heldRunId !== null)
            return yield* failed(
              "A facet binding cannot adopt a run held by another native session.",
            );
          sequence = welcome.ackedSequence;
          connection = welcome.connection;
          let sent: RunnerTurn | undefined;
          let completed: RunnerTurn | undefined;
          let interruptRequested = false;
          let steers = 0;
          const responses = new Set<string>();
          const pump = lock.withPermits(1)(
            Effect.gen(function* () {
              yield* currentActor;
              const work = yield* runner.work;
              if (work.drain !== null || work.pull != null || work.workflowStops.length > 0)
                return yield* failed("This facet cannot execute machine control work.");
              if (sent !== undefined && sent.runId !== work.activeRunId) {
                if (!interruptRequested) {
                  yield* session.control({ type: "interrupt", runId: sent.runId });
                  interruptRequested = true;
                }
                return;
              }
              if (work.preparation?.status === "cancelling" && sent === undefined) {
                yield* batch([
                  {
                    kind: "preparation.cancelled",
                    runId: work.preparation.runId,
                    preparationGeneration: work.preparation.generation,
                  },
                ]);
                return;
              }
              if (work.turn !== null && sent?.runId !== work.turn.runId) {
                const turn = work.turn;
                const access = yield* options.access(work);
                // Recheck after resolving grants; another publisher may have replaced the lease.
                yield* currentActor;
                // Host.open has hydrated these files; this facet has no machine checkout to run.
                if (
                  work.preparation?.status === "preparing" &&
                  turn.preparationGeneration !== undefined
                ) {
                  yield* batch([
                    {
                      kind: "preparation.ready",
                      runId: turn.runId,
                      preparationGeneration: turn.preparationGeneration,
                    },
                  ]);
                }
                const ready = yield* runner.work;
                if (
                  ready.turn?.runId !== turn.runId ||
                  ready.turn.preparationGeneration !== turn.preparationGeneration ||
                  ready.preparation?.status !== "handoff"
                )
                  return;
                // A new canonical thread has no native runtime session until this host accepts it.
                const boundTurn =
                  turn.providerThread.providerSessionId === null
                    ? {
                        ...turn,
                        providerThread: {
                          ...turn.providerThread,
                          providerSessionId: session.providerSession.id,
                        },
                      }
                    : turn;
                sent = boundTurn;
                interruptRequested = false;
                steers = 0;
                responses.clear();
                yield* session.turn({ turn: boundTurn, access });
              }
              if (sent === undefined || sent.runId !== work.activeRunId) return;
              for (const message of work.steers.slice(steers)) {
                yield* session.control({ type: "steer", runId: sent.runId, message });
                steers++;
              }
              for (const response of work.runtimeResponses) {
                if (response.runId !== sent.runId || responses.has(response.requestId)) continue;
                yield* session.control(response);
                responses.add(response.requestId);
              }
            }),
          );
          const supervise = <A>(effect: Effect.Effect<A, HarnessError>) =>
            effect.pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  brokenError ??= failed("The Thread/Runner facet binding failed.", cause);
                  yield* Deferred.fail(broken, brokenError);
                }),
              ),
              Effect.forkIn(scope),
            );
          yield* session.events.pipe(
            Stream.runForEach((item) =>
              lock.withPermits(1)(
                Effect.gen(function* () {
                  yield* currentActor;
                  const late =
                    item.kind === "provider" &&
                    item.runId === completed?.runId &&
                    item.event.type !== "turn.terminal";
                  if (!("runId" in item) || (item.runId !== sent?.runId && !late))
                    return yield* failed(
                      "The native session emitted an event outside its handed run.",
                      { item, handedRunId: sent?.runId, completedRunId: completed?.runId },
                    );
                  if (item.kind === "provider" && item.event.type === "turn.terminal") {
                    if (sent === undefined)
                      return yield* failed("A terminal event has no handed turn.");
                    const checkpoint = yield* session.export();
                    yield* options.persistCheckpoint(checkpoint, sent);
                    completed = sent;
                    sent = undefined;
                    interruptRequested = false;
                    steers = 0;
                    responses.clear();
                  }
                  yield* batch([item]);
                }),
              ),
            ),
            Effect.andThen(Effect.fail(failed("The native session event stream ended."))),
            supervise,
          );
          const actor = yield* currentActor;
          const changes = yield* engine
            .subscribe(actor, { threadId: options.threadId })
            .pipe(
              Effect.mapError((cause) => failed("Could not subscribe to the bound thread.", cause)),
            );
          yield* changes.pipe(
            Stream.runForEach(() => pump),
            supervise,
          );
          yield* pump;
        }),
    };
  });

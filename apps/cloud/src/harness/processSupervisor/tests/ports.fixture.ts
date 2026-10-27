import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import {
  createHarnessProcessSupervisor,
  HarnessProcessSupervisorPortError,
  type HarnessProcessSupervisorCaller,
  type HarnessProcessSupervisorCompletion,
  type HarnessProcessSupervisorExecution,
  type HarnessProcessSupervisorOptions,
  type HarnessProcessSupervisorRestart,
  type HarnessProcessSupervisorSignal,
  type HarnessProcessSupervisorState,
  type HarnessProcessSupervisorStore,
} from "../../HarnessProcessSupervisor.ts";
import { layerCrypto } from "../../../platform.ts";
import { resumeInput, resumeResult } from "./cResume.fixture.ts";

export const initial = {
  incarnation: { generation: 1, facetNonce: "facet-1" },
  checkpoint: {
    checkpointId: "checkpoint-before",
    manifestSha256: "a".repeat(64),
    nativeSessionId: "native-session",
    completedTurnId: "completed-before",
  },
};
export const turn = { requestId: "request-1", turnId: "turn-1", inputSha256: "b".repeat(64) };

export const memoryStore = () => {
  let value: HarnessProcessSupervisorState | null = null;
  const writes: HarnessProcessSupervisorState[] = [];
  const waiters = new Set<{
    predicate: (state: HarnessProcessSupervisorState) => boolean;
    done: Deferred.Deferred<HarnessProcessSupervisorState>;
  }>();
  const store: HarnessProcessSupervisorStore = {
    read: Effect.sync(() => structuredClone(value)),
    compareAndSet: (revision, next) =>
      Effect.sync(() => {
        if ((value?.revision ?? null) !== revision) return false;
        value = structuredClone(next);
        writes.push(structuredClone(next));
        for (const waiter of waiters)
          if (waiter.predicate(value)) {
            Deferred.doneUnsafe(waiter.done, Effect.succeed(structuredClone(value)));
            waiters.delete(waiter);
          }
        return true;
      }),
  };
  const until = (predicate: (state: HarnessProcessSupervisorState) => boolean) =>
    Effect.gen(function* () {
      if (value !== null && predicate(value)) return structuredClone(value);
      const waiter = { predicate, done: yield* Deferred.make<HarnessProcessSupervisorState>() };
      waiters.add(waiter);
      return yield* Deferred.await(waiter.done).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            waiters.delete(waiter);
          }),
        ),
      );
    });
  return { store, until, writes, read: () => structuredClone(value) };
};

export const fixture = (policy?: HarnessProcessSupervisorOptions["policy"]) =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const signals = yield* Queue.unbounded<HarnessProcessSupervisorSignal>();
    const started = yield* Queue.unbounded<{
      execution: HarnessProcessSupervisorExecution;
      complete: Deferred.Deferred<
        HarnessProcessSupervisorCompletion,
        HarnessProcessSupervisorPortError
      >;
      joined: Deferred.Deferred<void>;
    }>();
    const intents: HarnessProcessSupervisorRestart[] = [];
    const resumes: Parameters<HarnessProcessSupervisorCaller["processResume"]["resume"]>[0][] = [];
    const turns: HarnessProcessSupervisorExecution[] = [];
    let subscriptions = 0;
    let releases = 0;
    let checkpoint = initial.checkpoint;
    const caller: HarnessProcessSupervisorCaller = {
      turn: (execution) =>
        Effect.gen(function* () {
          turns.push(execution);
          const complete = yield* Deferred.make<
            HarnessProcessSupervisorCompletion,
            HarnessProcessSupervisorPortError
          >();
          const joined = yield* Deferred.make<void>();
          yield* Queue.offer(started, { execution, complete, joined });
          return yield* Deferred.await(complete).pipe(
            Effect.ensuring(Deferred.succeed(joined, undefined)),
          );
        }),
      prepareResume: (intent) =>
        Effect.sync(() => {
          intents.push(intent);
          checkpoint = {
            ...intent.checkpoint,
            completedTurnId: intent.checkpoint.completedTurnId ?? "",
          };
          return resumeInput(intent);
        }),
      processResume: {
        resume: (input) =>
          Effect.sync(() => {
            resumes.push(input);
            return resumeResult(input, checkpoint);
          }),
      },
    };
    const ingress: HarnessProcessSupervisorOptions["ingress"] = {
      subscribe: Effect.acquireRelease(
        Effect.sync(() => {
          subscriptions++;
          return { take: Queue.take(signals) };
        }),
        () =>
          Effect.sync(() => {
            releases++;
          }),
      ),
    };
    const options: HarnessProcessSupervisorOptions = {
      initial,
      store: storage.store,
      caller,
      ingress,
      ...(policy === undefined ? {} : { policy }),
    };
    const open = (overrides: Partial<HarnessProcessSupervisorOptions> = {}) =>
      createHarnessProcessSupervisor({ ...options, ...overrides }).pipe(
        Effect.provide(layerCrypto),
      );
    const next = Queue.take(started);
    const send = (
      execution: HarnessProcessSupervisorExecution,
      eventId: string,
      kind: HarnessProcessSupervisorSignal["kind"] = "reset",
    ) =>
      Queue.offer(signals, {
        eventId,
        kind,
        nativeSessionId: execution.checkpoint.nativeSessionId,
        turnId: execution.turn.turnId,
        incarnation: execution.incarnation,
      });
    const finish = (running: Effect.Success<typeof next>) =>
      Deferred.succeed(running.complete, {
        turnId: running.execution.turn.turnId,
        incarnation: running.execution.incarnation,
        checkpoint: {
          ...running.execution.checkpoint,
          completedTurnId: running.execution.turn.turnId,
          checkpointId: `checkpoint-${running.execution.turn.turnId}`,
          manifestSha256: "c".repeat(64),
        },
      });
    return {
      open,
      options,
      caller,
      storage,
      next,
      send,
      finish,
      signals,
      intents,
      resumes,
      turns,
      subscriptions: () => ({ acquired: subscriptions, released: releases }),
    };
  });

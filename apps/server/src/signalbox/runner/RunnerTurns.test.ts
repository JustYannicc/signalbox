import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  NodeId,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThread = {
  id: ProviderThreadId.make("pt-1"),
  nativeThreadRef: null,
} as unknown as OrchestrationV2ProviderThread;

const turnFor = (n: number): RunnerTurn =>
  ({
    runId: RunId.make(`run-${n}`),
    attemptId: RunAttemptId.make(`attempt-${n}`),
    modelSelection: { instanceId, model: "m" },
    providerThread,
  }) as unknown as RunnerTurn;

const providerTurnStarted = (n: number): ProviderAdapterV2Event =>
  ({
    type: "provider_turn.updated",
    driver,
    providerTurn: {
      id: ProviderTurnId.make(`native-${n}`),
      providerThreadId: providerThread.id,
      nodeId: NodeId.make(`node-${n}`),
      runAttemptId: RunAttemptId.make(`attempt-${n}`),
      status: "running",
    },
  }) as unknown as ProviderAdapterV2Event;

/**
 * An adapter whose session the test drives: `ensureThread` waits until the
 * test lets it finish, and every call is recorded.
 */
const makeFakeAdapter = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const loaded = yield* Deferred.make<void>();
  const calls: Array<string> = [];
  const session = {
    providerSessionId: ProviderSessionId.make("session-1"),
    providerSession: {},
    events: Stream.fromQueue(events),
    ensureThread: () => Effect.as(Deferred.await(loaded), providerThread),
    startTurn: (input: { readonly runId: string }) =>
      Effect.sync(() => void calls.push(`start ${input.runId}`)),
    interruptTurn: (input: { readonly providerTurnId: string }) =>
      Effect.sync(() => void calls.push(`interrupt ${input.providerTurnId}`)),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const adapter = {
    instanceId,
    driver,
    openSession: () => Effect.succeed(session),
  } as unknown as ProviderAdapterV2Shape;
  return { adapter, events, loaded, calls };
});

describe("RunnerTurns", () => {
  it.effect(
    "interrupts a stopped turn once the harness names it, even after the next one starts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const reported: Array<RunnerItem> = [];
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            emit: (item) => Effect.sync(() => void reported.push(item)),
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start(turnFor(1));
          yield* Effect.yieldNow;
          // Stopped before the harness reported its turn id, then the next run starts.
          yield* turns.interrupt(RunId.make("run-1"));
          yield* turns.start(turnFor(2));
          yield* Effect.yieldNow;
          yield* Queue.offer(fake.events, providerTurnStarted(1));
          yield* Queue.offer(fake.events, providerTurnStarted(2));
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;

          expect(fake.calls).toEqual(["start run-1", "start run-2", "interrupt native-1"]);
        }),
      ),
  );

  it.effect("never starts a turn the thread stopped while its session loaded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const reported: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          emit: (item) => Effect.sync(() => void reported.push(item)),
        });
        yield* turns.start(turnFor(1));
        yield* Effect.yieldNow;
        // A reconnect's welcome says nothing is live any more.
        yield* turns.keepOnly(null);
        yield* Deferred.succeed(fake.loaded, undefined);
        for (let round = 0; round < 10; round++) yield* Effect.yieldNow;

        expect(fake.calls).toEqual([]);
        expect(reported).toEqual([]);
      }),
    ),
  );
});

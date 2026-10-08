import type {
  MachineUsage,
  RunnerItem,
  RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
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
import * as TestClock from "effect/testing/TestClock";

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

const turnFor = (n: number, thread = providerThread): RunnerTurn =>
  ({
    runId: RunId.make(`run-${n}`),
    traceId: `trace-${n}`,
    attemptId: RunAttemptId.make(`attempt-${n}`),
    modelSelection: { instanceId, model: "m" },
    providerThread: thread,
  }) as unknown as RunnerTurn;

const unmeasured: MachineUsage = {
  cpuSeconds: null,
  memoryBytes: null,
  memoryPeakBytes: null,
  memoryAverageBytes: null,
  diskUsedBytes: null,
  egressBytes: null,
};

/** Usage whose CPU seconds count the reads, so each report is told apart. */
const countingUsage = () => {
  let reads = 0;
  return Effect.sync((): MachineUsage => ({ ...unmeasured, cpuSeconds: ++reads }));
};

const turnEnded = (n: number): ProviderAdapterV2Event =>
  ({
    type: "turn.terminal",
    driver,
    providerThreadId: providerThread.id,
    providerTurnId: ProviderTurnId.make(`native-${n}`),
    runOrdinal: n,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  }) as unknown as ProviderAdapterV2Event;

/** Each item as a short label, in the order it went out. */
const label = (item: RunnerItem) => {
  switch (item.kind) {
    case "usage":
      return `usage ${item.runId} ${item.usage.cpuSeconds}`;
    case "provider":
      return `provider ${item.runId} ${String(item.event.type)}`;
    case "log":
      return `log ${item.runId} ${item.level}`;
    default:
      return `${item.kind} ${item.runId}`;
  }
};

const settle = Effect.gen(function* () {
  for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
});

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
    resumeThread: () => Effect.die(new Error("no rollout for Bearer sk-live-resume-secret")),
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
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start(turnFor(1), "token-1");
          yield* Effect.yieldNow;
          // Stopped before the harness reported its turn id, then the next run starts.
          yield* turns.interrupt(RunId.make("run-1"));
          yield* turns.start(turnFor(2), "token-2");
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
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
        });
        yield* turns.start(turnFor(1), "token-1");
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

  it.effect("hands the harness each turn's model token before the turn reaches it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: (token) => Effect.sync(() => void fake.calls.push(`token ${token}`)),
          usage: Effect.succeed(unmeasured),
          emit: () => Effect.void,
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        yield* turns.start(turnFor(1), "token-1");
        for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
        yield* turns.start(turnFor(2), "token-2");
        for (let round = 0; round < 10; round++) yield* Effect.yieldNow;

        expect(fake.calls).toEqual([
          "token token-1",
          "start run-1",
          "token token-2",
          "start run-2",
        ]);
      }),
    ),
  );

  it.effect(
    "reports usage around a turn, every half minute while it runs, in order with its items",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const reported: Array<RunnerItem> = [];
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: countingUsage(),
            emit: (item) => Effect.sync(() => void reported.push(item)),
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start(turnFor(1), "token-1");
          yield* settle;
          yield* TestClock.adjust("30 seconds");
          yield* settle;
          yield* Queue.offer(fake.events, turnEnded(1));
          yield* settle;
          // Idle, it reports every 5 minutes rather than every half minute.
          yield* TestClock.adjust("270 seconds");
          yield* settle;
          expect(reported.map(label).at(-1)).toBe("usage run-1 3");
          yield* TestClock.adjust("30 seconds");
          yield* settle;

          expect(reported.map(label)).toEqual([
            "usage run-1 1",
            "turn.started run-1",
            "usage run-1 2",
            "provider run-1 turn.terminal",
            "usage run-1 3",
            "usage null 4",
          ]);
        }),
      ),
  );

  it.effect("sends no usage from a machine that cannot measure any", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const reported: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        yield* turns.start(turnFor(1), "token-1");
        yield* settle;
        yield* Queue.offer(fake.events, turnEnded(1));
        yield* settle;
        yield* TestClock.adjust("30 seconds");
        yield* settle;

        expect(reported.map(label)).toEqual(["turn.started run-1", "provider run-1 turn.terminal"]);
      }),
    ),
  );

  it.effect("records why a turn failed to start, credentials redacted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reported: Array<RunnerItem> = [];
        const adapter = {
          instanceId,
          driver,
          openSession: () => Effect.die(new Error("login refused: token=sk-live-start-secret")),
        } as unknown as ProviderAdapterV2Shape;
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
        });
        yield* turns.start(turnFor(1), "token-1");
        yield* settle;

        expect(reported.map(label)).toEqual(["log run-1 error", "turn.failed run-1"]);
        const log = reported[0];
        expect(log?.kind === "log" && log.message).toContain(
          "turn failed to start: Error: login refused: token=[REDACTED]",
        );
        expect(JSON.stringify(reported)).not.toContain("sk-live-start-secret");
      }),
    ),
  );

  it.effect("records a failed native resume before starting fresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const reported: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        const resumable = {
          ...providerThread,
          nativeThreadRef: "native-thread",
        } as unknown as OrchestrationV2ProviderThread;
        yield* turns.start(turnFor(1, resumable), "token-1");
        yield* settle;

        expect(reported.map(label)).toEqual(["log run-1 warning", "turn.started run-1"]);
        const log = reported[0];
        expect(log?.kind === "log" && log.message).toContain(
          "native resume failed; starting a fresh session: Error: no rollout for Bearer [REDACTED]",
        );
        expect(fake.calls).toEqual(["start run-1"]);
      }),
    ),
  );
});

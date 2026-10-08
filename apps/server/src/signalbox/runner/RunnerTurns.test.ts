import type {
  MachineUsage,
  RunnerItem,
  RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  MessageId,
  NodeId,
  OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
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
import type { DriveOutcome, RunnerDrive } from "./RunnerDrive.ts";
import type { RunnerSessions } from "./RunnerSessions.ts";
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
    startTurn: (input: { readonly runId: string; readonly restartContinuationOfRunId?: string }) =>
      Effect.sync(
        () =>
          void calls.push(
            input.restartContinuationOfRunId === undefined
              ? `start ${input.runId}`
              : `start ${input.runId} continuing ${input.restartContinuationOfRunId}`,
          ),
      ),
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
          yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
          yield* Effect.yieldNow;
          // Stopped before the harness reported its turn id, then the next run starts.
          yield* turns.interrupt(RunId.make("run-1"));
          yield* turns.start({ turn: turnFor(2), modelToken: "token-2" });
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
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
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
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
        for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
        yield* turns.start({ turn: turnFor(2), modelToken: "token-2" });
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
    "saves after file changes, and reports a turn's end only once its files land, conflicts resolved by the agent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const prompts: Array<string> = [];
          const session = (yield* fake.adapter.openSession(
            {} as never,
          )) as ProviderAdapterV2SessionRuntime;
          const startTurn = session.startTurn;
          Object.assign(session, {
            startTurn: (input: Parameters<typeof startTurn>[0]) =>
              Effect.andThen(
                Effect.sync(() => void prompts.push(input.message.text)),
                startTurn(input),
              ),
          });
          const driveCalls: Array<string> = [];
          let outcome: DriveOutcome = { _tag: "conflict", files: ["notes.md"] };
          const drive: RunnerDrive = {
            prepare: (remoteToken) =>
              Effect.sync(() => void driveCalls.push(`prepare ${remoteToken}`)),
            autosave: Effect.sync(() => void driveCalls.push("autosave")),
            flush: Effect.void,
            finishTurn: () =>
              Effect.sync(() => {
                driveCalls.push("finish");
                return {
                  checkpoint: { start: null, commit: "c".repeat(40), files: [] },
                  outcome,
                };
              }),
            continueAfterResolution: Effect.sync(() => {
              driveCalls.push("continue");
              outcome = { _tag: "landed", main: "c".repeat(40) };
              return outcome;
            }),
            abandonMerge: Effect.sync(() => {
              driveCalls.push("abandon");
              return { _tag: "not_landed", reason: "abandoned" } as const;
            }),
          };
          const reported: Array<RunnerItem> = [];
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            openDrive: () => Effect.succeed(drive),
          });
          const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
            discard: true,
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          const turn = {
            ...turnFor(1),
            message: {
              messageId: MessageId.make("message-1"),
              text: "Write notes",
              attachments: [],
            },
            runOrdinal: 1,
            providerTurnOrdinal: 1,
          } as unknown as RunnerTurn;
          yield* turns.start({
            turn,
            modelToken: "token-1",
            drive: {
              driveId: "my/personal/user_1",
              token: "sbd1.x.y",
              remoteToken: "sbr1.x.y",
            },
          });
          yield* settle;
          expect(driveCalls).toEqual(["prepare sbr1.x.y"]);

          const now = DateTime.makeUnsafe(0);
          yield* Queue.offer(fake.events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make("item-1"),
              threadId,
              runId: RunId.make("run-1"),
              nodeId: null,
              providerThreadId: providerThread.id,
              providerTurnId: ProviderTurnId.make("native-1"),
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "file_change",
              fileName: "notes.md",
            },
          } as ProviderAdapterV2Event);
          const terminal = (n: number) =>
            ({
              type: "turn.terminal",
              driver,
              providerThreadId: providerThread.id,
              providerTurnId: ProviderTurnId.make(`native-${n}`),
              runOrdinal: 1,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            }) as ProviderAdapterV2Event;
          yield* Queue.offer(fake.events, terminal(1));
          yield* settle;
          // The turn's end is held while the agent resolves the conflict.
          expect(driveCalls).toEqual(["prepare sbr1.x.y", "autosave", "finish"]);
          expect(prompts).toHaveLength(2);
          expect(prompts[1]).toContain("notes.md");
          const kinds = () =>
            reported.map((item) => (item.kind === "provider" ? `${item.event.type}` : item.kind));
          expect(kinds()).toEqual([
            "turn.started",
            "turn_item.updated",
            "drive.checkpoint",
            "drive.notice",
          ]);

          // The adapter names the merge step's provider turn, then ends it.
          yield* Queue.offer(fake.events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make("native-2"),
              providerThreadId: providerThread.id,
              nodeId: NodeId.make("node-1"),
              runAttemptId: RunAttemptId.make("attempt-1:merge:1"),
              nativeTurnRef: null,
              ordinal: 1001,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          } as ProviderAdapterV2Event);
          yield* Queue.offer(fake.events, terminal(2));
          yield* settle;
          expect(driveCalls).toEqual(["prepare sbr1.x.y", "autosave", "finish", "continue"]);
          // One end, after the files landed.
          expect(kinds()).toEqual([
            "turn.started",
            "turn_item.updated",
            "drive.checkpoint",
            "drive.notice",
            "provider_turn.updated",
            "turn.terminal",
          ]);
        }),
      ),
  );
  it.effect("reports one end for a run stopped while the agent resolves a merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const prompts: Array<string> = [];
        const session = (yield* fake.adapter.openSession(
          {} as never,
        )) as ProviderAdapterV2SessionRuntime;
        const startTurn = session.startTurn;
        Object.assign(session, {
          startTurn: (input: Parameters<typeof startTurn>[0]) =>
            Effect.andThen(
              Effect.sync(() => void prompts.push(input.message.text)),
              startTurn(input),
            ),
        });
        const driveCalls: Array<string> = [];
        let outcome: DriveOutcome = { _tag: "conflict", files: ["notes.md"] };
        const drive: RunnerDrive = {
          prepare: (remoteToken) =>
            Effect.sync(() => void driveCalls.push(`prepare ${remoteToken}`)),
          autosave: Effect.sync(() => void driveCalls.push("autosave")),
          flush: Effect.void,
          finishTurn: () =>
            Effect.sync(() => {
              driveCalls.push("finish");
              return {
                checkpoint: { start: null, commit: "c".repeat(40), files: [] },
                outcome,
              };
            }),
          continueAfterResolution: Effect.sync(() => {
            driveCalls.push("continue");
            outcome = { _tag: "landed", main: "c".repeat(40) };
            return outcome;
          }),
          abandonMerge: Effect.sync(() => {
            driveCalls.push("abandon");
            return { _tag: "not_landed", reason: "abandoned" } as const;
          }),
        };
        const reported: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
          openDrive: () => Effect.succeed(drive),
        });
        const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
          discard: true,
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        const turn = {
          ...turnFor(1),
          message: {
            messageId: MessageId.make("message-1"),
            text: "Write notes",
            attachments: [],
          },
          runOrdinal: 1,
          providerTurnOrdinal: 1,
        } as unknown as RunnerTurn;
        yield* turns.start({
          turn,
          modelToken: "token-1",
          drive: {
            driveId: "my/personal/user_1",
            token: "sbd1.x.y",
            remoteToken: "sbr1.x.y",
          },
        });
        yield* settle;
        expect(driveCalls).toEqual(["prepare sbr1.x.y"]);

        const now = DateTime.makeUnsafe(0);
        yield* Queue.offer(fake.events, {
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: TurnItemId.make("item-1"),
            threadId,
            runId: RunId.make("run-1"),
            nodeId: null,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make("native-1"),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "file_change",
            fileName: "notes.md",
          },
        } as ProviderAdapterV2Event);
        const terminal = (n: number) =>
          ({
            type: "turn.terminal",
            driver,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make(`native-${n}`),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          }) as ProviderAdapterV2Event;
        yield* Queue.offer(fake.events, terminal(1));
        yield* settle;
        // The turn's end is held while the agent resolves the conflict.
        expect(driveCalls).toEqual(["prepare sbr1.x.y", "autosave", "finish"]);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("notes.md");
        const kinds = () =>
          reported.map((item) => (item.kind === "provider" ? `${item.event.type}` : item.kind));
        expect(kinds()).toEqual([
          "turn.started",
          "turn_item.updated",
          "drive.checkpoint",
          "drive.notice",
        ]);

        // Stopped mid-merge: the merge is dropped and the run ends once.
        yield* turns.interrupt(RunId.make("run-1"));
        yield* settle;
        yield* Queue.offer(fake.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: ProviderTurnId.make("native-2"),
            providerThreadId: providerThread.id,
            nodeId: NodeId.make("node-1"),
            runAttemptId: RunAttemptId.make("attempt-1:merge:1"),
            nativeTurnRef: null,
            ordinal: 1001,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        } as ProviderAdapterV2Event);
        yield* Queue.offer(fake.events, {
          ...terminal(2),
          status: "interrupted",
        } as ProviderAdapterV2Event);
        yield* settle;
        expect(driveCalls).toEqual(["prepare sbr1.x.y", "autosave", "finish", "abandon"]);
        expect(kinds().filter((kind) => kind === "turn.terminal")).toHaveLength(1);
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
          yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
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
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
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
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
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
        yield* turns.start({ turn: turnFor(1, resumable), modelToken: "token-1" });
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

  describe("sessions", () => {
    /** Sessions that record what the turn asked of them, in `log`. */
    const makeFakeSessions = (log: Array<string>) =>
      Effect.map(Queue.unbounded<string>(), (failures) => ({
        failures,
        sessions: {
          use: (access) => Effect.sync(() => void log.push(`use ${access.token}`)),
          prepare: (kind) => Effect.sync(() => void log.push(`prepare ${kind}`)),
          settle: (_kind, event) => Effect.sync(() => void log.push(`settle ${event.type}`)),
          failures,
          claude: undefined as never,
          flush: (kind) => Effect.sync(() => void log.push(`flush ${kind}`)),
        } satisfies RunnerSessions,
      }));

    it.effect("restores the session before the harness loads it, and continues a lost run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const { sessions } = yield* makeFakeSessions(fake.calls);
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: () => Effect.void,
            sessions,
          });
          const continuation = {
            ...turnFor(2),
            restartContinuationOfRunId: RunId.make("run-1"),
          } as RunnerTurn;
          yield* turns.start({
            turn: continuation,
            modelToken: "token-2",
            drive: null,
            sessions: { token: "sbs1.t.2" },
          });
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
          // The harness has not loaded its session yet; it is on disk already.
          expect(fake.calls).toEqual(["use sbs1.t.2", "prepare codex"]);
          yield* Deferred.succeed(fake.loaded, undefined);
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
          expect(fake.calls.at(-1)).toBe("start run-2 continuing run-1");
        }),
      ),
    );

    it.effect("reports something complete only once the rows behind it are saved", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const log: Array<string> = [];
          const { sessions } = yield* makeFakeSessions(log);
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void log.push(`emit ${item.kind}`)),
            sessions,
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start({
            turn: turnFor(1),
            modelToken: "token-1",
            drive: null,
            sessions: { token: "sbs1.t.1" },
          });
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
          const now = DateTime.makeUnsafe(0);
          const reply: OrchestrationV2TurnItem = {
            id: TurnItemId.make("item-1"),
            threadId,
            runId: RunId.make("run-1"),
            nodeId: null,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make("native-1"),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make("message-1"),
            text: "Done.",
            streaming: false,
          };
          yield* Queue.offer(fake.events, { type: "turn_item.updated", driver, turnItem: reply });
          for (let round = 0; round < 20; round++) yield* Effect.yieldNow;
          expect(log.slice(-2)).toEqual(["settle turn_item.updated", "emit provider"]);
        }),
      ),
    );

    it.effect("stops a turn whose rows stop being saved, and says why", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const { sessions, failures } = yield* makeFakeSessions([]);
          const reported: Array<RunnerItem> = [];
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            sessions,
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start({
            turn: turnFor(1),
            modelToken: "token-1",
            drive: null,
            sessions: { token: "sbs1.t.1" },
          });
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
          yield* Queue.offer(fake.events, providerTurnStarted(1));
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;

          yield* Queue.offer(
            failures,
            "This turn's session could not be saved, so it was stopped.",
          );
          for (let round = 0; round < 10; round++) yield* Effect.yieldNow;
          expect(reported).toContainEqual({
            kind: "session.notice",
            runId: RunId.make("run-1"),
            message: "This turn's session could not be saved, so it was stopped.",
          });
          expect(fake.calls).toContain("interrupt native-1");
        }),
      ),
    );

    describe("on a light machine", () => {
      const command = (status: "running" | "completed", input: string, exitCode?: number) => {
        const now = DateTime.makeUnsafe(0);
        return {
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: TurnItemId.make(`item-${input}`),
            threadId,
            runId: RunId.make("run-1"),
            nodeId: null,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make("native-1"),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status,
            title: null,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            updatedAt: now,
            type: "command_execution",
            input,
            ...(exitCode === undefined ? {} : { exitCode }),
          },
        } as ProviderAdapterV2Event;
      };

      /** A light machine's turn with a drive, and everything it did in order. */
      const lightTurn = (machineClass: "light" | "heavy") =>
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const log: Array<string> = [];
          const { sessions } = yield* makeFakeSessions(log);
          const drive = {
            prepare: () => Effect.void,
            autosave: Effect.sync(() => void log.push("autosave")),
            flush: Effect.sync(() => void log.push("drive flush")),
          } as unknown as RunnerDrive;
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) =>
              Effect.sync(
                () =>
                  void log.push(
                    item.kind === "provider" ? `emit ${String(item.event.type)}` : item.kind,
                  ),
              ),
            openDrive: () => Effect.succeed(drive),
            sessions,
            machineClass,
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start({
            turn: turnFor(1),
            modelToken: "token-1",
            drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
            sessions: { token: "sbs1.t.1" },
          });
          yield* settle;
          log.length = 0;
          return { fake, log };
        });

      it.effect("saves everything, then hands a build to a heavy machine and drops the rest", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, log } = yield* lightTurn("light");
            yield* Queue.offer(fake.events, command("running", "sed -n 1,5p notes.md"));
            yield* Queue.offer(fake.events, command("running", "/bin/bash -lc 'npm run build'"));
            yield* Queue.offer(fake.events, command("completed", "npm run build"));
            yield* Queue.offer(fake.events, turnEnded(1));
            for (let round = 0; round < 30; round++) yield* Effect.yieldNow;

            expect(log).toEqual([
              "settle turn_item.updated",
              "emit turn_item.updated",
              "settle turn_item.updated",
              // The build shows as started, so the thread can report it interrupted.
              "emit turn_item.updated",
              "autosave",
              "drive flush",
              "flush codex",
              "machine.outgrown",
            ]);
          }),
        ),
      );

      it.effect("moves a turn up when a command is killed for memory", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, log } = yield* lightTurn("light");
            yield* Queue.offer(fake.events, command("completed", "node render.js", 137));
            for (let round = 0; round < 30; round++) yield* Effect.yieldNow;
            expect(log.at(-1)).toBe("machine.outgrown");
          }),
        ),
      );

      it.effect("never moves a heavy machine's turn", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, log } = yield* lightTurn("heavy");
            yield* Queue.offer(fake.events, command("running", "npm run build"));
            for (let round = 0; round < 30; round++) yield* Effect.yieldNow;
            expect(log).not.toContain("machine.outgrown");
          }),
        ),
      );
    });
  });
});

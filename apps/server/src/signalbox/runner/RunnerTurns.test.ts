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
import type { DriveOutcome, PreparedDrive, RunnerDrive } from "./RunnerDrive.ts";
import { RunnerInstructionsError } from "./RunnerInstructions.ts";
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
              Effect.sync(() => {
                driveCalls.push(`prepare ${remoteToken}`);
                return { instructions: "", notices: [] };
              }),
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
            Effect.sync(() => {
              driveCalls.push(`prepare ${remoteToken}`);
              return { instructions: "", notices: [] };
            }),
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

  describe("shortcut instructions", () => {
    /** A drive whose turn starts answer `prepared`, one per turn, in order. */
    const preparingDrive = (
      prepared: Array<Effect.Effect<PreparedDrive, RunnerInstructionsError>>,
    ) =>
      ({
        prepare: () => prepared.shift()!,
        autosave: Effect.void,
        flush: Effect.void,
        finishTurn: () =>
          Effect.succeed({
            checkpoint: null,
            outcome: { _tag: "landed", main: "c".repeat(40) } as const,
          }),
        continueAfterResolution: Effect.die(new Error("not in this test")),
        abandonMerge: Effect.die(new Error("not in this test")),
      }) as RunnerDrive;
    const access = { driveId: "drive-1", token: "drive-token", remoteToken: "remote-token" };
    const withMessage = (turn: RunnerTurn): RunnerTurn =>
      ({
        ...turn,
        message: {
          messageId: MessageId.make(`message-${turn.runId}`),
          text: "Hi",
          attachments: [],
        },
      }) as unknown as RunnerTurn;

    it.effect(
      "restarts the harness session when they change, so its native resume loads them",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const calls: Array<string> = [];
            let opened = 0;
            const adapter = {
              instanceId,
              driver,
              openSession: () =>
                Effect.gen(function* () {
                  const n = ++opened;
                  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
                  calls.push(`open ${n}`);
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => void calls.push(`close ${n}`)),
                  );
                  return {
                    providerSessionId: ProviderSessionId.make(`session-${n}`),
                    providerSession: {},
                    events: Stream.fromQueue(events),
                    ensureThread: () =>
                      Effect.sync(() => {
                        calls.push(`ensure ${n}`);
                        return providerThread;
                      }),
                    resumeThread: () =>
                      Effect.sync(() => {
                        calls.push(`resume ${n}`);
                        return providerThread;
                      }),
                    // Each turn runs to its end, as the harness reports it.
                    startTurn: (input: { readonly runId: string }) =>
                      Effect.gen(function* () {
                        calls.push(`start ${input.runId}`);
                        const ordinal = Number(input.runId.replace("run-", ""));
                        yield* Queue.offer(events, {
                          type: "provider_turn.updated",
                          driver,
                          providerTurn: {
                            id: ProviderTurnId.make(`native-${ordinal}`),
                            providerThreadId: providerThread.id,
                            nodeId: NodeId.make(`node-${ordinal}`),
                            runAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
                            nativeTurnRef: null,
                            ordinal,
                            status: "running",
                            startedAt: null,
                            completedAt: null,
                          },
                        } as unknown as ProviderAdapterV2Event);
                        yield* Queue.offer(events, turnEnded(ordinal));
                      }),
                  } as unknown as ProviderAdapterV2SessionRuntime;
                }),
            } as unknown as ProviderAdapterV2Shape;
            const prepared = (instructions: string) =>
              Effect.succeed({ instructions, notices: [] } satisfies PreparedDrive);
            const turns = yield* makeRunnerTurns({
              threadId,
              adapters: new Map([[instanceId, adapter]]),
              cwd: "/tmp",
              useModelToken: () => Effect.void,
              usage: Effect.succeed(unmeasured),
              emit: () => Effect.void,
              openDrive: () =>
                Effect.succeed(
                  preparingDrive([prepared("code/ rules"), prepared("code/ rules"), prepared("")]),
                ),
            });
            const resumable = {
              ...providerThread,
              nativeThreadRef: "native-thread",
            } as unknown as OrchestrationV2ProviderThread;
            yield* turns.start({
              turn: withMessage(turnFor(1)),
              modelToken: "token-1",
              drive: access,
            });
            yield* settle;
            // Same instructions: the same session takes the turn.
            yield* turns.start({
              turn: withMessage(turnFor(2, resumable)),
              modelToken: "t",
              drive: access,
            });
            yield* settle;
            // The shortcut is gone: a new session resumes the thread without its instructions.
            yield* turns.start({
              turn: withMessage(turnFor(3, resumable)),
              modelToken: "t",
              drive: access,
            });
            yield* settle;

            expect(calls).toEqual([
              "open 1",
              "ensure 1",
              "start run-1",
              "resume 1",
              "start run-2",
              "close 1",
              "open 2",
              "resume 2",
              "start run-3",
            ]);
          }),
        ),
    );

    it.effect("fails the turn with the reason when they are over the cap", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const reported: Array<RunnerItem> = [];
          const message =
            "This drive's instructions come to 80.0 KiB, over the 64.0 KiB agents can load: code/AGENTS.md 80.0 KiB. Shorten them or remove a shortcut, then send the message again.";
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            openDrive: () =>
              Effect.succeed(
                preparingDrive([Effect.fail(new RunnerInstructionsError({ message }))]),
              ),
          });
          yield* turns.start({ turn: turnFor(1), modelToken: "token-1", drive: access });
          yield* settle;

          expect(reported.map(label)).toEqual(["log run-1 error", "turn.failed run-1"]);
          const failed = reported[1];
          expect(failed?.kind === "turn.failed" && failed.message).toBe(message);
          expect(fake.calls).toEqual([]);
        }),
      ),
    );
  });

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
  });
});

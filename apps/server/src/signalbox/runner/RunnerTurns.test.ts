import {
  REQUEST_HEAVY_MACHINE_COMMAND,
  REQUEST_HEAVY_MACHINE_REASON,
  type MachineUsage,
  type RunnerItem,
  type RunnerTurn,
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
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { DriveOutcome, PreparedDrive, RunnerDrive, RunnerDriveError } from "./RunnerDrive.ts";
import { RunnerAttachmentsError } from "./RunnerAttachments.ts";
import { RunnerGitError } from "./RunnerGit.ts";
import { RunnerInstructionsError } from "./RunnerInstructions.ts";
import type { RunnerSessions } from "./RunnerSessions.ts";
import { DriveTooLargeError } from "./RunnerDriveClient.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const providerThread = {
  id: ProviderThreadId.make("pt-1"),
  nativeThreadRef: null,
} as unknown as OrchestrationV2ProviderThread;
const claudeProviderThread = {
  id: ProviderThreadId.make("pt-claude"),
  nativeThreadRef: null,
} as unknown as OrchestrationV2ProviderThread;

const turnFor = (
  n: number,
  thread = providerThread,
  selectedInstanceId: typeof instanceId | typeof claudeInstanceId = instanceId,
): RunnerTurn =>
  ({
    runId: RunId.make(`run-${n}`),
    traceId: `trace-${n}`,
    attemptId: RunAttemptId.make(`attempt-${n}`),
    modelSelection: { instanceId: selectedInstanceId, model: "m" },
    providerThread: thread,
    appThread: { pullRequests: [] },
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
    case "machine.drained":
      return `${item.kind} ${item.id}`;
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
      nativeTurnRef: null,
      ordinal: n,
      status: "running",
      startedAt: null,
      completedAt: null,
    },
  }) as unknown as ProviderAdapterV2Event;

/**
 * An adapter whose session the test drives: `ensureThread` waits until the
 * test lets it finish, and every call is recorded.
 */
const makeFakeAdapterFor = (selection: {
  readonly instanceId: typeof instanceId | typeof claudeInstanceId;
  readonly driver: typeof driver | typeof claudeDriver;
  readonly providerThread: OrchestrationV2ProviderThread;
}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const loaded = yield* Deferred.make<void>();
    const calls: Array<string> = [];
    /** What each `startTurn` got, beyond what `calls` names. */
    const started: Array<{
      readonly providerTurnOrdinal: number;
      readonly text: string | undefined;
      readonly nativeThreadRef: unknown;
    }> = [];
    const startedRuns = yield* Queue.unbounded<string>();
    const opened = { count: 0 };
    const session = {
      providerSessionId: ProviderSessionId.make("session-1"),
      providerSession: {},
      events: Stream.fromQueue(events),
      ensureThread: () => Effect.as(Deferred.await(loaded), selection.providerThread),
      resumeThread: () => Effect.die(new Error("no rollout for Bearer sk-live-resume-secret")),
      startTurn: (input: {
        readonly runId: string;
        readonly restartContinuationOfRunId?: string;
        readonly providerTurnOrdinal: number;
        readonly message?: { readonly text: string };
        readonly providerThread: { readonly nativeThreadRef: unknown };
      }) =>
        Effect.gen(function* () {
          started.push({
            providerTurnOrdinal: input.providerTurnOrdinal,
            text: input.message?.text,
            nativeThreadRef: input.providerThread.nativeThreadRef,
          });
          calls.push(
            input.restartContinuationOfRunId === undefined
              ? `start ${input.runId}`
              : `start ${input.runId} continuing ${input.restartContinuationOfRunId}`,
          );
          yield* Queue.offer(startedRuns, input.runId);
        }),
      interruptTurn: (input: { readonly providerTurnId: string }) =>
        Effect.sync(() => void calls.push(`interrupt ${input.providerTurnId}`)),
      steerTurn: (input: {
        readonly providerTurnId: string;
        readonly message: { readonly messageId: string };
      }) =>
        Effect.sync(
          () => void calls.push(`steer ${input.providerTurnId} ${input.message.messageId}`),
        ),
    } as unknown as ProviderAdapterV2SessionRuntime;
    const adapter = {
      instanceId: selection.instanceId,
      driver: selection.driver,
      openSession: () => Effect.sync(() => (opened.count++, session)),
    } as unknown as ProviderAdapterV2["Service"];
    return { adapter, events, loaded, calls, started, startedRuns, opened };
  });
const makeFakeAdapter = makeFakeAdapterFor({
  instanceId,
  driver,
  providerThread,
});
const makeFakeClaudeAdapter = makeFakeAdapterFor({
  instanceId: claudeInstanceId,
  driver: claudeDriver,
  providerThread: claudeProviderThread,
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
          // Stopped before the harness reported its turn id, then the next run is handed over.
          yield* turns.interrupt(RunId.make("run-1"));
          yield* turns.start({ turn: turnFor(2), modelToken: "token-2" });
          yield* Effect.yieldNow;
          yield* Queue.offer(fake.events, providerTurnStarted(1));
          yield* settle;
          // The next turn waits until the stopped one has ended on the harness.
          expect(fake.calls).toEqual(["start run-1", "interrupt native-1"]);
          yield* Queue.offer(fake.events, turnEnded(1));
          yield* settle;

          expect(fake.calls).toEqual(["start run-1", "interrupt native-1", "start run-2"]);
        }),
      ),
  );

  it.effect("stops the turn the thread no longer wants when it hands over the next one", () =>
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
        yield* Queue.offer(fake.events, providerTurnStarted(1));
        yield* settle;
        // The thread ended run 1, but its `interrupt` never reached this machine (#562).
        yield* turns.start({ turn: turnFor(2), modelToken: "token-2" });
        yield* settle;
        expect(fake.calls).toEqual(["start run-1", "interrupt native-1"]);

        yield* Queue.offer(fake.events, turnEnded(1));
        yield* settle;
        expect(fake.calls).toEqual(["start run-1", "interrupt native-1", "start run-2"]);
        expect(reported.map(label)).not.toContain("turn.failed run-2");
      }),
    ),
  );

  it.effect("restarts the harness's session when a stopped turn never ends", () =>
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
        yield* Queue.offer(fake.events, providerTurnStarted(1));
        yield* settle;
        // A command that ignores the interrupt: the harness never ends the turn.
        yield* turns.interrupt(RunId.make("run-1"));
        yield* turns.start({ turn: turnFor(2), modelToken: "token-2" });
        yield* settle;
        expect(fake.calls).toEqual(["start run-1", "interrupt native-1"]);
        expect(fake.opened.count).toBe(1);

        yield* TestClock.adjust("20 seconds");
        yield* settle;
        expect(fake.opened.count).toBe(2);
        expect(fake.calls).toEqual(["start run-1", "interrupt native-1", "start run-2"]);
        expect(reported.map(label)).toContain("log run-2 warning");
        expect(reported.map(label)).not.toContain("turn.failed run-2");
      }),
    ),
  );

  it.effect("hands each message steered into a turn to the harness once it names the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: () => Effect.void,
        });
        const message = (n: number) => ({
          messageId: MessageId.make(`message-${n}`),
          text: `steer ${n}`,
          attachments: [],
          createdBy: "user" as const,
          creationSource: "web" as const,
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
        yield* settle;
        // Sent before the harness named its turn: held until it does.
        yield* turns.steer(RunId.make("run-1"), message(2));
        yield* settle;
        expect(fake.calls).toEqual(["start run-1"]);

        yield* Queue.offer(fake.events, providerTurnStarted(1));
        yield* settle;
        // A reconnect hands it over again, and another one follows.
        yield* turns.steer(RunId.make("run-1"), message(2));
        yield* turns.steer(RunId.make("run-1"), message(3));
        // A run this machine doesn't hold takes nothing.
        yield* turns.steer(RunId.make("run-9"), message(4));
        yield* settle;
        expect(fake.calls).toEqual([
          "start run-1",
          "steer native-1 message-2",
          "steer native-1 message-3",
        ]);
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
        yield* Queue.offer(fake.events, providerTurnStarted(1));
        yield* Queue.offer(fake.events, turnEnded(1));
        yield* settle;
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
            restoreDependencyEdits: Effect.void,
            saveNow: Effect.void,
            changed: Effect.succeed(false),
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
            takeInMain: Effect.die(new Error("not in this test")),
            abandonMerge: Effect.sync(() => {
              driveCalls.push("abandon");
              return { _tag: "not_landed", reason: "abandoned" } as const;
            }),
            saveBranch: () => Effect.die(new Error("not in this test")),
            published: () => Effect.void,
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
          restoreDependencyEdits: Effect.void,
          saveNow: Effect.void,
          changed: Effect.succeed(false),
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
          takeInMain: Effect.die(new Error("not in this test")),
          abandonMerge: Effect.sync(() => {
            driveCalls.push("abandon");
            return { _tag: "not_landed", reason: "abandoned" } as const;
          }),
          saveBranch: () => Effect.die(new Error("not in this test")),
          published: () => Effect.void,
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

  describe("after the thread's pull request merged (#495)", () => {
    /**
     * A turn whose start took in main and hit a conflict: the drive records
     * what the turns ask of it, and the agent's prompts are kept in order.
     */
    const conflicted = (resolves = true) =>
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
        const drive: RunnerDrive = {
          prepare: (_remoteToken, _author, _folders, pullRequests) =>
            Effect.sync(() => {
              driveCalls.push(`prepare ${pullRequests?.map((link) => link.number).join(",")}`);
              return {
                instructions: "",
                notices: [],
                mainConflict: { pullRequest: 7, branch: "main", files: ["src/app.ts"] },
              };
            }),
          autosave: Effect.void,
          flush: Effect.void,
          restoreDependencyEdits: Effect.void,
          saveNow: Effect.void,
          changed: Effect.succeed(false),
          finishTurn: () => Effect.die(new Error("not in this test")),
          continueAfterResolution: Effect.sync((): DriveOutcome => {
            driveCalls.push("continue");
            return resolves
              ? { _tag: "saved", head: "c".repeat(40) }
              : { _tag: "conflict", files: ["src/app.ts"] };
          }),
          takeInMain: Effect.sync(() => {
            driveCalls.push("take in");
            return { _tag: "conflict", files: ["src/app.ts"] } as const;
          }),
          abandonMerge: Effect.sync(() => {
            driveCalls.push("abandon");
            return { _tag: "not_landed", reason: "abandoned" } as const;
          }),
          saveBranch: () => Effect.die(new Error("not in this test")),
          published: () => Effect.void,
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
        yield* Deferred.succeed(fake.loaded, undefined);
        const turn = {
          ...turnFor(1),
          appThread: { pullRequests: [{ number: 7 }] },
          message: { messageId: MessageId.make("message-1"), text: "Next thing", attachments: [] },
          runOrdinal: 1,
          providerTurnOrdinal: 1,
        } as unknown as RunnerTurn;
        yield* turns.start({
          turn,
          modelToken: "token-1",
          drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: "sbr1.x.y" },
        });
        yield* settle;
        const now = DateTime.makeUnsafe(0);
        /** The harness names merge step `n`'s provider turn. */
        const mergeStepNamed = (n = 1) =>
          Queue.offer(fake.events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`native-sync-${n}`),
              providerThreadId: providerThread.id,
              nodeId: NodeId.make("node-1"),
              runAttemptId: RunAttemptId.make(`attempt-1:sync:${n}`),
              nativeTurnRef: null,
              ordinal: 1101,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          } as ProviderAdapterV2Event);
        const mergeStepEnded = (status: "completed" | "interrupted", n = 1) =>
          Queue.offer(fake.events, {
            type: "turn.terminal",
            driver,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make(`native-sync-${n}`),
            runOrdinal: 1,
            status,
            failure: null,
            threadDisposition: "reusable",
          } as ProviderAdapterV2Event);
        const notices = () =>
          reported.flatMap((item) => (item.kind === "drive.notice" ? [item.message] : []));
        return {
          fake,
          turns,
          prompts,
          driveCalls,
          reported,
          mergeStepNamed,
          mergeStepEnded,
          notices,
        };
      });

    it.effect("has the agent resolve a conflict with main before the turn's own message", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { prompts, driveCalls, reported, mergeStepNamed, mergeStepEnded, notices } =
            yield* conflicted();
          // The merge step runs first; the person's message waits for it.
          expect(driveCalls).toEqual(["prepare 7", "take in"]);
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).toContain("Pull request #7 merged");
          expect(prompts[0]).toContain("- src/app.ts");
          expect(notices()).toEqual([
            "Pull request #7 merged, so this thread is taking in the latest main. It conflicts in src/app.ts; resolving that first.",
          ]);

          yield* mergeStepNamed();
          yield* mergeStepEnded("completed");
          yield* settle;
          expect(driveCalls).toEqual(["prepare 7", "take in", "continue"]);
          expect(prompts).toEqual([prompts[0], "Next thing"]);
          expect(notices()[1]).toBe("The latest main is merged in.");
          // The merge step's end is not the run's.
          expect(
            reported.filter(
              (item) => item.kind === "provider" && item.event.type === "turn.terminal",
            ),
          ).toEqual([]);
        }),
      ),
    );

    it.effect("drops main still conflicted after two tries, says so, then runs the message", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { prompts, driveCalls, mergeStepNamed, mergeStepEnded, notices } =
            yield* conflicted(false);
          for (const n of [1, 2]) {
            yield* mergeStepNamed(n);
            yield* mergeStepEnded("completed", n);
            yield* settle;
          }
          expect(driveCalls).toEqual(["prepare 7", "take in", "continue", "continue", "abandon"]);
          expect(prompts.slice(2)).toEqual(["Next thing"]);
          expect(notices()[1]).toBe(
            "The latest main isn't merged in: src/app.ts still conflicted. This turn works on the branch as it was; the next one tries again.",
          );
        }),
      ),
    );

    it.effect("never sends the message of a run stopped while the agent resolves main", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, turns, prompts, driveCalls, mergeStepNamed, mergeStepEnded, notices } =
            yield* conflicted();
          // Stopped before the harness named the merge step: it's interrupted once it does.
          yield* turns.interrupt(RunId.make("run-1"));
          yield* settle;
          yield* mergeStepNamed();
          yield* settle;
          yield* mergeStepEnded("interrupted");
          yield* settle;
          expect(fake.calls).toContain("interrupt native-sync-1");
          expect(driveCalls).toEqual(["prepare 7", "take in", "abandon"]);
          expect(prompts).toHaveLength(1);
          // No turn follows to hear about it.
          expect(notices()).toHaveLength(1);
        }),
      ),
    );
  });

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

  it.effect("names a disconnected machine filesystem before the provider starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const failed = yield* Deferred.make<RunnerItem>();
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "writeFile",
                pathOrDescriptor: "/machine/model-token.next",
                cause: Object.assign(new Error("socket is not connected: token=sk-secret"), {
                  code: "ENOTCONN",
                }),
              }),
            ),
          usage: Effect.succeed(unmeasured),
          emit: (item) =>
            item.kind === "turn.failed"
              ? Deferred.succeed(failed, item).pipe(Effect.asVoid)
              : Effect.void,
        });
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
        const item = yield* Deferred.await(failed);
        expect(item.kind === "turn.failed" && item.message).toBe(
          "Signalbox couldn't write this machine's state (ENOTCONN: filesystem disconnected).",
        );
        expect(fake.calls).toEqual([]);
        expect(JSON.stringify(item)).not.toContain("sk-secret");
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
        } as unknown as ProviderAdapterV2["Service"];
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
        // A thread from before #653 sends no conversation for a new session.
        yield* turns.start({
          turn: { ...turnFor(1, resumable), message: { text: "Hi" } } as unknown as RunnerTurn,
          modelToken: "token-1",
        });
        yield* settle;

        expect(reported.map(label)).toEqual(["log run-1 warning", "turn.started run-1"]);
        const log = reported[0];
        expect(log?.kind === "log" && log.message).toContain(
          "native resume failed; starting a fresh session: Error: no rollout for Bearer [REDACTED]",
        );
        expect(fake.calls).toEqual(["start run-1"]);
        expect(fake.started).toEqual([
          { providerTurnOrdinal: 1, text: "Hi", nativeThreadRef: null },
        ]);
      }),
    ),
  );

  // #653: a continuation or later turn on a new session would start with no conversation.
  it.effect("starts a failed resume fresh, with the conversation the thread sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: () => Effect.void,
        });
        yield* Deferred.succeed(fake.loaded, undefined);
        const resumable = {
          ...providerThread,
          nativeThreadRef: "native-thread",
        } as unknown as OrchestrationV2ProviderThread;
        const fresh = "User:\nRemember 42.\n\nUser message:\nContinue where you left off.";
        yield* turns.start({
          turn: {
            ...turnFor(2, resumable),
            providerTurnOrdinal: 3,
            message: { text: "Continue where you left off." },
            restartContinuationOfRunId: RunId.make("run-1"),
            freshSessionText: fresh,
          } as unknown as RunnerTurn,
          modelToken: "token-1",
        });
        yield* settle;

        // A new session has nothing to continue: it gets the conversation as a request.
        expect(fake.calls).toEqual(["start run-2"]);
        expect(fake.started).toEqual([
          { providerTurnOrdinal: 1, text: fresh, nativeThreadRef: null },
        ]);
      }),
    ),
  );

  describe("shortcut instructions", () => {
    /** A drive whose turn starts answer `prepared`, one per turn, in order. */
    const preparingDrive = (
      prepared: Array<Effect.Effect<PreparedDrive, RunnerDriveError | RunnerInstructionsError>>,
    ) =>
      ({
        prepare: () => prepared.shift()!,
        autosave: Effect.void,
        flush: Effect.void,
        restoreDependencyEdits: Effect.void,
        saveNow: Effect.void,
        changed: Effect.succeed(false),
        finishTurn: () =>
          Effect.succeed({
            checkpoint: null,
            outcome: { _tag: "landed", main: "c".repeat(40) } as const,
          }),
        continueAfterResolution: Effect.die(new Error("not in this test")),
        takeInMain: Effect.die(new Error("not in this test")),
        abandonMerge: Effect.die(new Error("not in this test")),
        saveBranch: () => Effect.die(new Error("not in this test")),
        published: () => Effect.void,
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
            } as unknown as ProviderAdapterV2["Service"];
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
            "This thread's instructions come to 80.0 KiB, over the 64.0 KiB agents can load: code/AGENTS.md 80.0 KiB. Shorten a folder's instructions or remove a shortcut, then send the message again.";
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

    it.effect("fails the turn with what's too big when the drive can't take it", () =>
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
            openDrive: () =>
              Effect.succeed(
                preparingDrive([
                  Effect.fail(
                    new DriveTooLargeError({
                      message: "Signalbox can't save owner/repo to its drive: This save is 80 MB.",
                    }),
                  ),
                ]),
              ),
          });
          yield* turns.start({ turn: turnFor(1), modelToken: "token-1", drive: access });
          yield* settle;

          const failed = reported.find((item) => item.kind === "turn.failed");
          expect(failed?.kind === "turn.failed" && failed.message).toBe(
            "Signalbox couldn't get this thread's files ready: Signalbox can't save owner/repo to its drive: This save is 80 MB.",
          );
        }),
      ),
    );

    it.effect("fails the turn with why its files couldn't be readied, credentials redacted", () =>
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
            openDrive: () =>
              Effect.succeed(
                preparingDrive([
                  Effect.fail(
                    new RunnerGitError({
                      message:
                        "Saving owner/repo's latest version failed: A pack of 110795399 bytes is bigger than the drive takes (67108864). token=abc123",
                    }),
                  ),
                ]),
              ),
          });
          yield* turns.start({ turn: turnFor(1), modelToken: "token-1", drive: access });
          yield* settle;

          expect(reported.map(label)).toEqual(["log run-1 error", "turn.failed run-1"]);
          const failed = reported[1];
          expect(failed?.kind === "turn.failed" && failed.message).toBe(
            "Signalbox couldn't get this thread's files ready: Saving owner/repo's latest version failed: A pack of 110795399 bytes is bigger than the drive takes (67108864). token=[REDACTED]",
          );
          expect(fake.calls).toEqual([]);
        }),
      ),
    );
  });

  describe("sessions", () => {
    /** Sessions that record what the turn asked of them, in `log`. */
    const makeFakeSessions = (
      log: Array<string>,
      onSettle?: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
    ) =>
      Effect.map(Queue.unbounded<string>(), (failures) => ({
        failures,
        sessions: {
          use: (access) => Effect.sync(() => void log.push(`use ${access.token}`)),
          prepare: (kind) => Effect.sync(() => void log.push(`prepare ${kind}`)),
          settle: (_kind, event) =>
            Effect.gen(function* () {
              log.push(`settle ${event.type}`);
              if (onSettle !== undefined) yield* onSettle(event);
            }),
          failures,
          claude: undefined as never,
          flush: (kind) =>
            Effect.sync(() => {
              log.push(`flush ${kind}`);
              return null;
            }),
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

    it.effect("fails the turn naming the pasted file that couldn't reach the machine", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const { sessions } = yield* makeFakeSessions([]);
          const reported: Array<RunnerItem> = [];
          const message = `Signalbox couldn't get "notes.txt" onto this thread's machine: the download stalled for 30 seconds`;
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            sessions,
            attachments: {
              bring: () => Effect.fail(new RunnerAttachmentsError({ message, retryable: true })),
            },
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          const pasted = { ...turnFor(1), message: { text: "See notes", attachments: [] } };
          yield* turns.start({
            turn: pasted as unknown as RunnerTurn,
            modelToken: "token-1",
            drive: null,
            sessions: { token: "sbs1.t.1" },
          });
          yield* settle;

          expect(reported.map(label)).toEqual(["log run-1 error", "turn.failed run-1"]);
          const failed = reported[1];
          expect(failed?.kind === "turn.failed" && failed.message).toBe(message);
          expect(fake.calls.some((call) => call.startsWith("start"))).toBe(false);
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
      const command = (
        status: "running" | "completed",
        input: string,
        exitCode?: number,
        runId: RunId | null = RunId.make("run-1"),
        eventDriver: typeof driver | typeof claudeDriver = driver,
        selectedThread: OrchestrationV2ProviderThread = providerThread,
      ) => {
        const now = DateTime.makeUnsafe(0);
        return {
          type: "turn_item.updated",
          driver: eventDriver,
          turnItem: {
            id: TurnItemId.make(`item-${input}`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: selectedThread.id,
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

      const subagentCommand = (
        input: string,
        harness: "codex" | "claude",
      ): ProviderAdapterV2Event => {
        const selectedDriver = harness === "claude" ? claudeDriver : driver;
        const selectedThread = harness === "claude" ? claudeProviderThread : providerThread;
        const event = command("running", input, undefined, null, selectedDriver, selectedThread);
        if (event.type !== "turn_item.updated") throw new Error("Expected a command item");
        return { ...event, turnItem: { ...event.turnItem, runId: null, providerTurnId: null } };
      };

      /** A light machine's turn with a drive, and everything it did in order. */
      const lightTurn = (machineClass: "light" | "heavy", harness: "codex" | "claude" = "codex") =>
        Effect.gen(function* () {
          const fakeAdapter = harness === "claude" ? makeFakeClaudeAdapter : makeFakeAdapter;
          const fake = yield* fakeAdapter;
          const selectedInstance = harness === "claude" ? claudeInstanceId : instanceId;
          const selectedDriver = harness === "claude" ? claudeDriver : driver;
          const selectedThread = harness === "claude" ? claudeProviderThread : providerThread;
          const reported: Array<RunnerItem> = [];
          const log: Array<string> = [];
          const settledEvents = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const handedOff = yield* Deferred.make<void>();
          const { sessions } = yield* makeFakeSessions(log, (event) =>
            Queue.offer(settledEvents, event).pipe(Effect.asVoid),
          );
          const drive = {
            prepare: () => Effect.void,
            autosave: Effect.sync(() => void log.push("autosave")),
            flush: Effect.sync(() => void log.push("drive flush")),
            restoreDependencyEdits: Effect.void,
            saveNow: Effect.sync(() => void log.push("drive save")),
            changed: Effect.succeed(false),
          } as unknown as RunnerDrive;
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[selectedInstance, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) =>
              Effect.gen(function* () {
                reported.push(item);
                log.push(item.kind === "provider" ? `emit ${String(item.event.type)}` : item.kind);
                if (item.kind === "machine.outgrown") {
                  yield* Deferred.succeed(handedOff, undefined);
                }
              }),
            openDrive: () => Effect.succeed(drive),
            sessions,
            machineClass,
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start({
            turn: turnFor(1, selectedThread, selectedInstance),
            modelToken: "token-1",
            drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
            sessions: { token: "sbs1.t.1" },
          });
          yield* settle;
          log.length = 0;
          return { fake, log, reported, selectedDriver, selectedThread, settledEvents, handedOff };
        });

      it.effect.each(["codex", "claude"] as const)(
        "lets %s request a heavy machine through the outgrown path",
        (harness) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, log, reported, selectedDriver, selectedThread, handedOff } =
                yield* lightTurn("light", harness);
              const input =
                harness === "claude"
                  ? `/bin/bash -lc '${REQUEST_HEAVY_MACHINE_COMMAND}'`
                  : REQUEST_HEAVY_MACHINE_COMMAND;
              yield* Queue.offer(
                fake.events,
                command(
                  "running",
                  input,
                  undefined,
                  RunId.make("run-1"),
                  selectedDriver,
                  selectedThread,
                ),
              );
              yield* Deferred.await(handedOff);

              expect(reported.filter((item) => item.kind === "log")).toEqual([]);
              expect(log).toEqual([
                "settle turn_item.updated",
                "drive save",
                "flush " + selectedDriver,
                "machine.outgrown",
              ]);
              expect(
                reported.some(
                  (item) =>
                    item.kind === "provider" &&
                    item.event.type === "turn_item.updated" &&
                    JSON.stringify(item.event).includes(REQUEST_HEAVY_MACHINE_COMMAND),
                ),
              ).toBe(false);
              expect(reported.find((item) => item.kind === "machine.outgrown")).toMatchObject({
                runId: RunId.make("run-1"),
                reason: REQUEST_HEAVY_MACHINE_REASON,
              });
            }),
          ),
      );

      it.effect.each(["codex", "claude"] as const)(
        "moves up for a runless %s subagent request",
        (harness) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, reported, handedOff } = yield* lightTurn("light", harness);
              yield* Queue.offer(
                fake.events,
                subagentCommand(REQUEST_HEAVY_MACHINE_COMMAND, harness),
              );
              yield* Deferred.await(handedOff);

              expect(reported.filter((item) => item.kind === "machine.outgrown")).toMatchObject([
                {
                  runId: RunId.make("run-1"),
                  reason: REQUEST_HEAVY_MACHINE_REASON,
                },
              ]);
              expect(
                reported.some(
                  (item) =>
                    item.kind === "provider" &&
                    item.event.type === "turn_item.updated" &&
                    JSON.stringify(item.event).includes(REQUEST_HEAVY_MACHINE_COMMAND),
                ),
              ).toBe(false);
            }),
          ),
      );

      it.effect.each(["codex", "claude"] as const)(
        "leaves a displayed %s request command on the light machine",
        (harness) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, reported, settledEvents } = yield* lightTurn("light", harness);
              const input = "printf '%s\\n' '" + REQUEST_HEAVY_MACHINE_COMMAND + "'";
              yield* Queue.offer(fake.events, subagentCommand(input, harness));
              yield* Queue.take(settledEvents);

              expect(reported.filter((item) => item.kind === "machine.outgrown")).toEqual([]);
              expect(
                reported.some(
                  (item) =>
                    item.kind === "provider" &&
                    item.event.type === "turn_item.updated" &&
                    JSON.stringify(item.event).includes(REQUEST_HEAVY_MACHINE_COMMAND),
                ),
              ).toBe(true);
            }),
          ),
      );

      it.effect("ignores a runless request from an older provider session", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const codex = yield* makeFakeAdapter;
            const claude = yield* makeFakeClaudeAdapter;
            const settledEvents = yield* Queue.unbounded<ProviderAdapterV2Event>();
            const reported: Array<RunnerItem> = [];
            const { sessions } = yield* makeFakeSessions([], (event) =>
              Queue.offer(settledEvents, event).pipe(Effect.asVoid),
            );
            const turns = yield* makeRunnerTurns({
              threadId,
              adapters: new Map([
                [instanceId, codex.adapter],
                [claudeInstanceId, claude.adapter],
              ]),
              cwd: "/tmp",
              machineClass: "light",
              useModelToken: () => Effect.void,
              usage: Effect.succeed(unmeasured),
              emit: (item) => Effect.sync(() => void reported.push(item)),
              sessions,
            });

            yield* Deferred.succeed(codex.loaded, undefined);
            yield* turns.start({
              turn: turnFor(1, providerThread, instanceId),
              modelToken: "token-1",
              sessions: { token: "sbs1.t.1" },
            });
            expect(yield* Queue.take(codex.startedRuns)).toBe("run-1");

            yield* Deferred.succeed(claude.loaded, undefined);
            yield* turns.start({
              turn: turnFor(2, claudeProviderThread, claudeInstanceId),
              modelToken: "token-2",
              sessions: { token: "sbs1.t.2" },
            });
            expect(yield* Queue.take(claude.startedRuns)).toBe("run-2");

            yield* Queue.offer(
              codex.events,
              subagentCommand(REQUEST_HEAVY_MACHINE_COMMAND, "codex"),
            );
            yield* Queue.take(settledEvents);

            expect(reported.filter((item) => item.kind === "machine.outgrown")).toEqual([]);
          }),
        ),
      );

      it.effect("ignores an explicit request from a stale run", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const {
              fake,
              log,
              reported,
              selectedDriver,
              selectedThread,
              settledEvents,
              handedOff,
            } = yield* lightTurn("light");
            yield* Queue.offer(
              fake.events,
              command(
                "running",
                REQUEST_HEAVY_MACHINE_COMMAND,
                undefined,
                RunId.make("run-old"),
                selectedDriver,
                selectedThread,
              ),
            );
            yield* Queue.take(settledEvents);
            expect(log).not.toContain("machine.outgrown");

            yield* Queue.offer(
              fake.events,
              command(
                "running",
                REQUEST_HEAVY_MACHINE_COMMAND,
                undefined,
                RunId.make("run-1"),
                selectedDriver,
                selectedThread,
              ),
            );
            yield* Deferred.await(handedOff);
            expect(reported.filter((item) => item.kind === "machine.outgrown")).toHaveLength(1);
          }),
        ),
      );

      it.effect.each(["codex", "claude"] as const)(
        "treats a heavy-machine request from %s as a no-op",
        (harness) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, log, reported, selectedDriver, selectedThread, settledEvents } =
                yield* lightTurn("heavy", harness);
              for (const status of ["running", "completed"] as const) {
                yield* Queue.offer(
                  fake.events,
                  command(
                    status,
                    REQUEST_HEAVY_MACHINE_COMMAND,
                    undefined,
                    RunId.make("run-1"),
                    selectedDriver,
                    selectedThread,
                  ),
                );
              }
              yield* Queue.take(settledEvents);
              yield* Queue.take(settledEvents);
              expect(reported.filter((item) => item.kind === "machine.outgrown")).toEqual([]);
              expect(
                reported.filter(
                  (item) =>
                    item.kind === "provider" &&
                    item.event.type === "turn_item.updated" &&
                    JSON.stringify(item.event).includes(REQUEST_HEAVY_MACHINE_COMMAND),
                ),
              ).toEqual([]);
              expect(log).toEqual([
                "settle turn_item.updated",
                "autosave",
                "settle turn_item.updated",
              ]);
            }),
          ),
      );

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
              // Everything saved, as for any machine about to go (#493).
              "drive save",
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

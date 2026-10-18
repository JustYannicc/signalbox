import type {
  DependencyProgress,
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
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
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
import type { RunnerDependencies } from "./RunnerDependencies.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThread = {
  id: ProviderThreadId.make("pt-1"),
  nativeThreadRef: null,
} as unknown as OrchestrationV2ProviderThread;
const providerSessionId = ProviderSessionId.make("session-1");

const turnFor = (n: number, thread = providerThread): RunnerTurn =>
  ({
    runId: RunId.make(`run-${n}`),
    traceId: `trace-${n}`,
    attemptId: RunAttemptId.make(`attempt-${n}`),
    modelSelection: { instanceId, model: "m" },
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
    case "git.pull.result":
      return `${item.kind} ${item.result.id}`;
    case "git.pull.interrupted":
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

const runtimeRequestPending = (
  requestId: RuntimeRequestId,
  providerTurnId = ProviderTurnId.make("native-1"),
): ProviderAdapterV2Event =>
  ({
    type: "runtime_request.updated",
    driver,
    runtimeRequest: {
      id: requestId,
      nodeId: NodeId.make(`node-${requestId}`),
      providerTurnId,
      nativeRequestRef: null,
      kind: "permission",
      status: "pending",
      responseCapability: { type: "live", providerSessionId },
      createdAt: DateTime.makeUnsafe(0),
      resolvedAt: null,
    },
  }) as unknown as ProviderAdapterV2Event;

/**
 * An adapter whose session the test drives: `ensureThread` waits until the
 * test lets it finish, and every call is recorded.
 */
const makeFakeAdapter = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const loaded = yield* Deferred.make<void>();
  const failNextResponse = yield* Ref.make(false);
  const secondStarted = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const calls: Array<string> = [];
  const responses: Array<{ readonly requestId: string; readonly decision?: string }> = [];
  /** What each `startTurn` got, beyond what `calls` names. */
  const started: Array<{
    readonly providerTurnOrdinal: number;
    readonly text: string | undefined;
    readonly nativeThreadRef: unknown;
  }> = [];
  const opened = { count: 0 };
  const session = {
    providerSessionId: ProviderSessionId.make("session-1"),
    providerSession: {},
    events: Stream.fromQueue(events),
    ensureThread: () => Effect.as(Deferred.await(loaded), providerThread),
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
        if (input.runId === "run-2") yield* Deferred.succeed(secondStarted, undefined);
      }),
    interruptTurn: (input: { readonly providerTurnId: string }) =>
      Effect.gen(function* () {
        calls.push(`interrupt ${input.providerTurnId}`);
        yield* Deferred.succeed(interrupted, undefined);
      }),
    steerTurn: (input: {
      readonly providerTurnId: string;
      readonly message: { readonly messageId: string };
    }) =>
      Effect.sync(
        () => void calls.push(`steer ${input.providerTurnId} ${input.message.messageId}`),
      ),
    respondToRuntimeRequest: (input: { readonly requestId: string; readonly decision?: string }) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failNextResponse, false)) {
          return yield* Effect.fail({ _tag: "ResponseFailed" as const });
        }
        responses.push(input);
      }),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const adapter = {
    instanceId,
    driver,
    openSession: () => Effect.sync(() => (opened.count++, session)),
  } as unknown as ProviderAdapterV2["Service"];
  return {
    adapter,
    events,
    loaded,
    calls,
    started,
    opened,
    responses,
    failNextResponse,
    secondStarted,
    interrupted,
  };
});

const startWithDependencies = (input: {
  readonly machineClass: "light" | "heavy";
  readonly resume?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeAdapter;
      const order: Array<string> = [];
      const emitted: Array<RunnerItem> = [];
      const drive = {
        prepare: () =>
          Effect.sync(() => {
            order.push("drive prepare");
            return { instructions: "", notices: [] } satisfies PreparedDrive;
          }),
        autosave: Effect.void,
        flush: Effect.void,
        restoreDependencyEdits: Effect.sync(() => void order.push("restore dependency edits")),
        saveNow: Effect.void,
        changed: Effect.succeed(false),
      } as unknown as RunnerDrive;
      const dependencies: RunnerDependencies = {
        prepare: (_notify, progress) =>
          Effect.gen(function* () {
            order.push("dependencies prepare");
            if (progress !== undefined) {
              const updates: ReadonlyArray<DependencyProgress> = [
                {
                  root: "",
                  status: "installing",
                  reason: "new",
                  message: "Installing dependencies in this folder from package-lock.json.",
                },
                {
                  root: "",
                  status: "installed",
                  reason: "new",
                  durationMs: 5,
                  message: "Dependencies in this folder are ready.",
                },
              ];
              for (const update of updates) yield* progress(update);
            }
            return [];
          }),
        trees: Effect.succeed([]),
      };
      const adapter: ProviderAdapterV2["Service"] = {
        ...fake.adapter,
        openSession: (openInput) =>
          fake.adapter.openSession(openInput).pipe(
            Effect.map((session) => ({
              ...session,
              ...(input.resume === true
                ? {
                    resumeThread: (
                      resumeInput: Parameters<
                        NonNullable<ProviderAdapterV2SessionRuntime["resumeThread"]>
                      >[0],
                    ) =>
                      Effect.sync(() => void order.push("resume thread")).pipe(
                        Effect.as(resumeInput.providerThread),
                      ),
                  }
                : {}),
            })),
            Effect.tap(() => Effect.sync(() => void order.push("open session"))),
          ),
      };
      const turns = yield* makeRunnerTurns({
        threadId,
        adapters: new Map([[instanceId, adapter]]),
        cwd: "/tmp",
        useModelToken: () => Effect.void,
        usage: Effect.succeed(unmeasured),
        emit: (item) => Effect.sync(() => void emitted.push(item)),
        openDrive: () => Effect.succeed(drive),
        dependencies,
        machineClass: input.machineClass,
      });
      yield* Deferred.succeed(fake.loaded, undefined);
      yield* turns.start({
        turn: turnFor(
          1,
          input.resume === true
            ? ({
                ...providerThread,
                nativeThreadRef: { nativeId: "native-1" },
              } as typeof providerThread)
            : providerThread,
        ),
        modelToken: "token-1",
        drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
      });
      yield* settle;
      return { fake, order, emitted };
    }),
  );

describe("RunnerTurns", () => {
  it.effect("only answers a request observed on the matching live attempt and session", () =>
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
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
        yield* settle;
        yield* Queue.offer(fake.events, providerTurnStarted(1));
        yield* settle;

        const requestId = RuntimeRequestId.make("request-1");
        const response = {
          type: "runtime-request.respond",
          runId: RunId.make("run-1"),
          attemptId: RunAttemptId.make("attempt-1"),
          providerSessionId,
          requestId,
          decision: "accept",
        } as const;

        // A response frame cannot create permission to answer a request the harness never raised.
        yield* turns.respondRuntimeRequest(response);
        expect(fake.responses).toEqual([]);

        yield* Queue.offer(fake.events, runtimeRequestPending(requestId));
        yield* settle;
        yield* turns.respondRuntimeRequest({
          ...response,
          attemptId: RunAttemptId.make("attempt-2"),
        });
        yield* turns.respondRuntimeRequest({ ...response, runId: RunId.make("run-2") });
        yield* turns.respondRuntimeRequest({
          ...response,
          providerSessionId: ProviderSessionId.make("another-session"),
        });
        expect(fake.responses).toEqual([]);

        yield* Ref.set(fake.failNextResponse, true);
        yield* turns.respondRuntimeRequest(response);
        expect(fake.responses).toEqual([]);

        // A failed adapter call remains eligible for the cloud's committed replay.
        yield* turns.respondRuntimeRequest(response);
        yield* turns.respondRuntimeRequest(response);
        yield* Queue.offer(fake.events, runtimeRequestPending(requestId));
        yield* settle;
        yield* turns.respondRuntimeRequest(response);
        expect(fake.responses).toEqual([{ requestId, decision: "accept" }]);
      }),
    ),
  );

  it.effect("reports an interrupted pull when its drive cannot be opened yet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reported: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map(),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
          openDrive: () => Effect.die(new Error("drive is not ready")),
        });
        const operation = {
          id: "pull-before-open",
          target: "a".repeat(40),
          expectedThread: "b".repeat(40),
          expectedWip: null,
          revision: null,
          branch: "threads/thread-1",
        } as const;

        yield* turns.pull({
          operation,
          drive: { driveId: "drive-1", token: "drive-token", remoteToken: "remote-token" },
        });

        expect(reported).toEqual([{ kind: "git.pull.interrupted", id: operation.id }]);
      }),
    ),
  );

  it.effect("refuses a pull while the machine still owns an active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAdapter;
        const reported: Array<RunnerItem> = [];
        const blocked: Array<string | undefined> = [];
        const pull: RunnerDrive["pull"] = (operation, _remoteToken, blockedReason) => {
          blocked.push(blockedReason);
          return Effect.succeed({
            id: operation.id,
            target: operation.target,
            head: operation.expectedThread,
            wip: operation.expectedWip,
            outcome: "refused",
            reason: blockedReason ?? null,
            hasWorkingTreeChanges: false,
          });
        };
        const drive = { pull } as unknown as RunnerDrive;
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, fake.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed(unmeasured),
          emit: (item) => Effect.sync(() => void reported.push(item)),
          openDrive: () => Effect.succeed(drive),
        });
        const operation = {
          id: "pull-while-running",
          target: "a".repeat(40),
          expectedThread: "b".repeat(40),
          expectedWip: null,
          revision: null,
          branch: "threads/thread-1",
        } as const;

        yield* Deferred.succeed(fake.loaded, undefined);
        yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
        yield* turns.pull({
          operation,
          drive: { driveId: "drive-1", token: "drive-token", remoteToken: "remote-token" },
        });

        expect(blocked).toEqual([
          "This thread is busy; wait for its current turn to finish before pulling.",
        ]);
        expect(reported.map(label)).toContain("git.pull.result " + operation.id);
      }),
    ),
  );

  it.effect(
    "starts on a light machine without preparing dependencies or restoring node_modules edits",
    () =>
      Effect.gen(function* () {
        const { fake, order, emitted } = yield* startWithDependencies({
          machineClass: "light",
        });

        expect(order).toEqual(["drive prepare", "open session"]);
        expect(fake.calls).toContain("start run-1");
        expect(emitted.some((item) => item.kind === "dependencies.progress")).toBe(false);
      }),
  );

  it.effect(
    "prepares dependencies and restores node_modules edits before native resume on heavy",
    () =>
      Effect.gen(function* () {
        const { fake, order, emitted } = yield* startWithDependencies({
          machineClass: "heavy",
          resume: true,
        });

        expect(order).toEqual([
          "drive prepare",
          "dependencies prepare",
          "restore dependency edits",
          "open session",
          "resume thread",
        ]);
        expect(fake.calls).toContain("start run-1");
        expect(emitted.filter((item) => item.kind === "dependencies.progress")).toEqual([
          {
            kind: "dependencies.progress",
            runId: RunId.make("run-1"),
            root: "",
            status: "installing",
            reason: "new",
            message: "Installing dependencies in this folder from package-lock.json.",
          },
          {
            kind: "dependencies.progress",
            runId: RunId.make("run-1"),
            root: "",
            status: "installed",
            reason: "new",
            durationMs: 5,
            message: "Dependencies in this folder are ready.",
          },
        ]);
      }),
  );

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
    "records an interrupted turn's auto-save and exact provider turn before reporting its end",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const reported: Array<RunnerItem> = [];
          const checkpoints: Array<{
            runId: string;
            turnId: string;
            threadId: string;
            views: unknown;
          }> = [];
          const driveCalls: Array<string> = [];
          const checkpoint = { start: "a".repeat(40), commit: "b".repeat(40), files: [] } as const;
          const context = {
            driveId: "home",
            contexts: [
              {
                contextId: "personal",
                name: "Personal",
                drives: [
                  {
                    driveId: "spec",
                    path: "My Drive/spec",
                    commit: "c".repeat(40),
                    time: 1,
                    shortcuts: [],
                  },
                ],
              },
            ],
          };
          const drive: RunnerDrive = {
            prepare: () => Effect.succeed({ instructions: "", notices: [] }),
            autosave: Effect.sync(() => void driveCalls.push("autosave")),
            flush: Effect.void,
            restoreDependencyEdits: Effect.void,
            saveNow: Effect.void,
            changed: Effect.succeed(false),
            checkpointViews: (pinned) => ({ shortcuts: [], context: pinned }),
            recordCheckpoint: (record) =>
              Effect.sync(
                () =>
                  void checkpoints.push({
                    runId: record.runId,
                    turnId: record.turnId,
                    threadId: record.threadId,
                    views: record.views,
                  }),
              ),
            captureCheckpoint: Effect.sync(() => {
              driveCalls.push("capture");
              return checkpoint;
            }),
            finishTurn: () => Effect.die(new Error("failed runs do not land")),
            continueAfterResolution: Effect.die(new Error("not in this test")),
            takeInMain: Effect.die(new Error("not in this test")),
            abandonMerge: Effect.die(new Error("not in this test")),
            saveBranch: () => Effect.die(new Error("not in this test")),
            published: () => Effect.void,
            pull: (operation) =>
              Effect.succeed({
                id: operation.id,
                target: operation.target,
                head: operation.expectedThread,
                wip: operation.expectedWip,
                outcome: "up_to_date",
                reason: null,
                hasWorkingTreeChanges: false,
              }),
          };
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            openDrive: () => Effect.succeed(drive),
            pinDrives: () => Effect.succeed(context),
          });
          yield* Deferred.succeed(fake.loaded, undefined);
          yield* turns.start({
            turn: turnFor(1),
            modelToken: "token-1",
            drive: { driveId: "home", token: "drive-token", remoteToken: null },
          });
          yield* settle;
          yield* Queue.offer(fake.events, providerTurnStarted(1));
          yield* settle;
          yield* Queue.offer(fake.events, {
            type: "turn.terminal",
            driver,
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make("native-1"),
            runOrdinal: 1,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          } as ProviderAdapterV2Event);
          yield* settle;

          expect(driveCalls).toEqual(["autosave", "capture"]);
          expect(checkpoints).toEqual([
            {
              runId: "run-1",
              turnId: "native-1",
              threadId: "thread-1",
              views: { shortcuts: [], context },
            },
          ]);
          expect(reported.map((item) => item.kind)).toContain("drive.checkpoint");
          expect(reported.at(-1)).toMatchObject({
            kind: "provider",
            event: { type: "turn.terminal" },
          });
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
          const checkpoints: Array<{ runId: string; turnId: string; threadId: string }> = [];
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
            checkpointViews: (context) => ({ shortcuts: [], context }),
            recordCheckpoint: (record) =>
              Effect.sync(
                () =>
                  void checkpoints.push({
                    runId: record.runId,
                    turnId: record.turnId,
                    threadId: record.threadId,
                  }),
              ),
            captureCheckpoint: Effect.succeed({ start: null, commit: "w".repeat(40), files: [] }),
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
            pull: (operation) =>
              Effect.succeed({
                id: operation.id,
                target: operation.target,
                head: operation.expectedThread,
                wip: operation.expectedWip,
                outcome: "up_to_date",
                reason: null,
                hasWorkingTreeChanges: false,
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
          expect(checkpoints).toEqual([
            { threadId: "thread-1", runId: "run-1", turnId: "native-1" },
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
        const checkpoints: Array<{ runId: string; turnId: string; threadId: string }> = [];
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
          checkpointViews: (context) => ({ shortcuts: [], context }),
          recordCheckpoint: (record) =>
            Effect.sync(
              () =>
                void checkpoints.push({
                  runId: record.runId,
                  turnId: record.turnId,
                  threadId: record.threadId,
                }),
            ),
          captureCheckpoint: Effect.succeed({ start: null, commit: "w".repeat(40), files: [] }),
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
          pull: (operation) =>
            Effect.succeed({
              id: operation.id,
              target: operation.target,
              head: operation.expectedThread,
              wip: operation.expectedWip,
              outcome: "up_to_date",
              reason: null,
              hasWorkingTreeChanges: false,
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
        expect(checkpoints).toEqual([{ threadId: "thread-1", runId: "run-1", turnId: "native-1" }]);

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
          checkpointViews: (context) => ({ shortcuts: [], context }),
          recordCheckpoint: () => Effect.void,
          captureCheckpoint: Effect.succeed(null),
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
          pull: (operation) =>
            Effect.succeed({
              id: operation.id,
              target: operation.target,
              head: operation.expectedThread,
              wip: operation.expectedWip,
              outcome: "up_to_date",
              reason: null,
              hasWorkingTreeChanges: false,
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

    it.effect("answers a runtime request from a native helper using the cloud attempt", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, turns, mergeStepNamed } = yield* conflicted();
          const requestId = RuntimeRequestId.make("helper-request");
          yield* mergeStepNamed();
          yield* settle;
          yield* Queue.offer(
            fake.events,
            runtimeRequestPending(requestId, ProviderTurnId.make("native-sync-1")),
          );
          yield* settle;

          yield* turns.respondRuntimeRequest({
            type: "runtime-request.respond",
            runId: RunId.make("run-1"),
            attemptId: RunAttemptId.make("attempt-1"),
            providerSessionId,
            requestId,
            decision: "accept",
          });

          expect(fake.responses).toEqual([{ requestId, decision: "accept" }]);
        }),
      ),
    );

    it.effect("drops a helper response after a newer helper becomes current", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, turns, mergeStepNamed, mergeStepEnded } = yield* conflicted(false);
          const staleRequestId = RuntimeRequestId.make("stale-helper-request");
          const response = {
            type: "runtime-request.respond" as const,
            runId: RunId.make("run-1"),
            attemptId: RunAttemptId.make("attempt-1"),
            providerSessionId,
            requestId: staleRequestId,
            decision: "accept" as const,
          };

          yield* mergeStepNamed(1);
          yield* settle;
          yield* Queue.offer(
            fake.events,
            runtimeRequestPending(staleRequestId, ProviderTurnId.make("native-sync-1")),
          );
          yield* settle;
          yield* mergeStepEnded("completed", 1);
          yield* settle;

          // The response for helper 1 keeps the cloud attempt id, which also names helper 2.
          yield* turns.respondRuntimeRequest(response);
          expect(fake.responses).toEqual([]);

          yield* mergeStepNamed(2);
          yield* settle;
          const currentRequestId = RuntimeRequestId.make("current-helper-request");
          yield* Queue.offer(
            fake.events,
            runtimeRequestPending(currentRequestId, ProviderTurnId.make("native-sync-2")),
          );
          yield* settle;
          yield* turns.respondRuntimeRequest({ ...response, requestId: currentRequestId });

          expect(fake.responses).toEqual([{ requestId: currentRequestId, decision: "accept" }]);
        }),
      ),
    );

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
        checkpointViews: (context) => ({ shortcuts: [], context }),
        recordCheckpoint: () => Effect.void,
        captureCheckpoint: Effect.succeed(null),
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
        pull: () => Effect.die(new Error("not in this test")),
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

  describe("draining preview work", () => {
    const emptyDrive = (saveNow: Effect.Effect<void, RunnerDriveError>) =>
      ({ saveNow }) as RunnerDrive;

    it.effect("refuses a pull until the preview drive's drain finishes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const reported: Array<RunnerItem> = [];
          const pull: RunnerDrive["pull"] = (operation, _token, reason) =>
            Effect.succeed({
              id: operation.id,
              target: operation.target,
              head: operation.expectedThread,
              wip: operation.expectedWip,
              outcome: "refused",
              reason: reason ?? null,
              hasWorkingTreeChanges: false,
            });
          const drive = {
            ...emptyDrive(
              Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
            ),
            pull,
          };
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map(),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) => Effect.sync(() => void reported.push(item)),
            openDrive: () => Effect.succeed(drive),
            previewDrive: () => drive,
          });
          const request = {
            operation: {
              id: "pull-during-drain",
              target: "a".repeat(40),
              expectedThread: "b".repeat(40),
              expectedWip: null,
              revision: null,
              branch: "threads/thread-1",
            },
            drive: { driveId: "drive-1", token: "drive-token", remoteToken: "remote-token" },
          };
          const drain = yield* Effect.forkChild(turns.drain);
          yield* Deferred.await(entered);
          yield* turns.pull(request);
          expect(reported).toMatchObject([
            {
              kind: "git.pull.result",
              result: {
                outcome: "refused",
                reason:
                  "This thread is saving before its machine leaves; try the pull again after it reconnects.",
              },
            },
          ]);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(drain)).toEqual([]);
          yield* turns.pull(request);
          expect(reported[1]).toMatchObject({ kind: "git.pull.result", result: { reason: null } });
        }),
      ),
    );

    it.effect("saves the preview-opened drive after checkout preparation finishes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const preparing = yield* Semaphore.make(1);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let saves = 0;
          const drive = emptyDrive(Effect.sync(() => void saves++));
          const fake = yield* makeFakeAdapter;
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: () => Effect.void,
            preparing,
            previewDrive: () => drive,
          });

          const preparation = yield* preparing
            .withPermits(1)(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const drain = yield* Effect.forkChild(turns.drain);
          yield* Effect.yieldNow;
          expect(saves).toBe(0);

          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(drain)).toEqual([]);
          yield* Fiber.join(preparation);
          expect(saves).toBe(1);
          expect(fake.calls).toEqual([]);
        }),
      ),
    );

    it.effect("reports an unsaved preview drive and retries its save on the next drain", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          let saves = 0;
          const drive = emptyDrive(
            Effect.suspend(() => {
              saves += 1;
              return saves === 1
                ? Effect.fail(new RunnerGitError({ message: "upload failed" }))
                : Effect.void;
            }),
          );
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: () => Effect.void,
            previewDrive: () => drive,
          });

          expect(yield* turns.drain).toEqual([
            "Saving this thread's files failed: Signalbox couldn't reach this thread's storage.",
          ]);
          expect(yield* turns.drain).toEqual([]);
          expect(saves).toBe(2);
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
      const subagentCommand = () => {
        const event = command("running", "npm test");
        if (event.type !== "turn_item.updated") throw new Error("Expected a command item");
        return {
          ...event,
          turnItem: { ...event.turnItem, runId: null, providerTurnId: null },
        };
      };
      const previewServiceStart = (
        status: "pending" | "running" | "completed",
        toolName: string,
      ) => {
        const now = DateTime.makeUnsafe(0);
        return {
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: TurnItemId.make("preview-service-start"),
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
            type: "dynamic_tool",
            toolName,
            input: { port: 5173, command: "npm run dev" },
          },
        } as ProviderAdapterV2Event;
      };

      /** A light machine's turn with a drive, and everything it did in order. */
      const lightTurn = (machineClass: "light" | "heavy", saveFailure?: "drive" | "session") =>
        Effect.gen(function* () {
          const fake = yield* makeFakeAdapter;
          const log: Array<string> = [];
          const reported: Array<RunnerItem> = [];
          const started = yield* Deferred.make<void>();
          const handedOff = yield* Deferred.make<void>();
          const failed = yield* Deferred.make<void>();
          const original = yield* makeFakeSessions(log);
          const sessions: RunnerSessions = {
            ...original.sessions,
            flush: (kind) =>
              original.sessions
                .flush(kind)
                .pipe(
                  Effect.map(() =>
                    saveFailure === "session" ? "session store unavailable" : null,
                  ),
                ),
          };
          const drive = {
            prepare: () => Effect.void,
            autosave: Effect.sync(() => void log.push("autosave")),
            flush: Effect.sync(() => void log.push("drive flush")),
            restoreDependencyEdits: Effect.void,
            saveNow: Effect.sync(() => void log.push("drive save")).pipe(
              Effect.andThen(
                saveFailure === "drive"
                  ? Effect.fail(new RunnerGitError({ message: "file store unavailable" }))
                  : Effect.void,
              ),
            ),
            changed: Effect.succeed(false),
          } as unknown as RunnerDrive;
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, fake.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed(unmeasured),
            emit: (item) =>
              Effect.sync(() => {
                reported.push(item);
                log.push(item.kind === "provider" ? `emit ${String(item.event.type)}` : item.kind);
              }).pipe(
                Effect.andThen(() =>
                  item.kind === "turn.started"
                    ? Deferred.succeed(started, undefined)
                    : item.kind === "machine.outgrown"
                      ? Deferred.succeed(handedOff, undefined)
                      : item.kind === "turn.failed"
                        ? Deferred.succeed(failed, undefined)
                        : Effect.void,
                ),
                Effect.asVoid,
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
          yield* Deferred.await(started);
          log.length = 0;
          return { fake, log, reported, turns, handedOff, failed };
        });

      it.effect.each(["drive", "session"] as const)(
        "does not hand off when the %s cannot be saved",
        (saveFailure) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, log, reported, failed } = yield* lightTurn("light", saveFailure);
              yield* Queue.offer(fake.events, providerTurnStarted(1));
              yield* Queue.offer(fake.events, command("running", "npm run build"));
              yield* Deferred.await(failed);
              yield* Deferred.await(fake.interrupted);

              expect(log).not.toContain("machine.outgrown");
              expect(reported).toContainEqual({
                kind: "turn.failed",
                runId: RunId.make("run-1"),
                message: expect.stringContaining(
                  saveFailure === "drive"
                    ? "Signalbox couldn't reach this thread's storage."
                    : "session store unavailable",
                ),
              });
              expect(fake.calls).toContain("interrupt native-1");
            }),
          ),
      );

      it.effect(
        "drops a failed handoff's late events while the next turn winds down its provider",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const { fake, reported, turns, failed } = yield* lightTurn("light", "session");
              yield* Queue.offer(fake.events, providerTurnStarted(1));
              yield* Queue.offer(fake.events, command("running", "npm run build"));
              yield* Deferred.await(failed);
              yield* turns.start({
                turn: turnFor(2),
                modelToken: "token-2",
                drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
                sessions: { token: "sbs1.t.2" },
              });
              yield* Queue.offer(fake.events, command("running", "npm run-script lint"));
              yield* Queue.offer(fake.events, {
                type: "message.updated",
                driver,
                message: {
                  id: MessageId.make("late-old-message"),
                  threadId,
                  runId: RunId.make("run-1"),
                  nodeId: null,
                  createdBy: "agent",
                  creationSource: "provider",
                  role: "assistant",
                  text: "A late reply from the failed turn.",
                  attachments: [],
                  streaming: false,
                  createdAt: DateTime.makeUnsafe(0),
                  updatedAt: DateTime.makeUnsafe(0),
                },
              });
              yield* Queue.offer(fake.events, turnEnded(1));
              yield* Deferred.await(fake.secondStarted);

              expect(
                reported.filter((item) => item.kind === "turn.failed").map((item) => item.runId),
              ).toEqual([RunId.make("run-1")]);
              expect(reported.some((item) => item.kind === "machine.outgrown")).toBe(false);
              expect(
                reported.some(
                  (item) => item.kind === "provider" && item.event.type === "message.updated",
                ),
              ).toBe(false);
              expect(fake.calls).toContain("start run-2");
            }),
          ),
      );

      it.effect.each(["identified", "subagent"] as const)(
        "does not move the current provider's run for a stopped provider's late %s command",
        (source) =>
          Effect.scoped(
            Effect.gen(function* () {
              const first = yield* makeFakeAdapter;
              const second = yield* makeFakeAdapter;
              const secondInstance = ProviderInstanceId.make("second-codex");
              const started = yield* Deferred.make<void>();
              const oldTerminal = yield* Deferred.make<void>();
              const reported: Array<RunnerItem> = [];
              const turns = yield* makeRunnerTurns({
                threadId,
                adapters: new Map([
                  [instanceId, first.adapter],
                  [secondInstance, { ...second.adapter, instanceId: secondInstance }],
                ]),
                cwd: "/tmp",
                useModelToken: () => Effect.void,
                usage: Effect.succeed(unmeasured),
                machineClass: "light",
                emit: (item) =>
                  Effect.gen(function* () {
                    reported.push(item);
                    if (item.kind === "turn.started" && item.runId === RunId.make("run-1")) {
                      yield* Deferred.succeed(started, undefined);
                    }
                    if (item.kind === "provider" && item.event.type === "turn.terminal") {
                      yield* Deferred.succeed(oldTerminal, undefined);
                    }
                  }),
              });
              yield* Deferred.succeed(first.loaded, undefined);
              yield* Deferred.succeed(second.loaded, undefined);
              yield* turns.start({ turn: turnFor(1), modelToken: "token-1" });
              yield* Deferred.await(started);
              yield* Queue.offer(first.events, providerTurnStarted(1));
              yield* turns.interrupt(RunId.make("run-1"));
              const next = turnFor(2);
              yield* turns.start({
                turn: {
                  ...next,
                  modelSelection: { ...next.modelSelection, instanceId: secondInstance },
                },
                modelToken: "token-2",
              });
              yield* Deferred.await(second.secondStarted);

              yield* Queue.offer(
                first.events,
                source === "subagent" ? subagentCommand() : command("running", "npm test"),
              );
              yield* Queue.offer(first.events, turnEnded(1));
              yield* Deferred.await(oldTerminal);
              expect(reported.some((item) => item.kind === "machine.outgrown")).toBe(false);
              expect(second.calls).toEqual(["start run-2"]);
            }),
          ),
      );

      it.effect("moves up for a current subagent's command without run identifiers", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, reported, handedOff } = yield* lightTurn("light");
            yield* Queue.offer(fake.events, subagentCommand());
            yield* Deferred.await(handedOff);
            expect(reported).toContainEqual({
              kind: "machine.outgrown",
              runId: RunId.make("run-1"),
              reason: expect.stringContaining("npm test"),
            });
          }),
        ),
      );

      it.effect(
        "clears usage attribution when a failed handoff leaves drive notices for the next run",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const fake = yield* makeFakeAdapter;
              const reported: Array<RunnerItem> = [];
              const started = yield* Deferred.make<void>();
              const failedHandoff = yield* Deferred.make<void>();
              const idleUsage = yield* Deferred.make<void>();
              const nextNotice = yield* Deferred.make<void>();
              let changed = false;
              const drive = {
                prepare: () =>
                  Effect.succeed({ instructions: "", notices: [] } satisfies PreparedDrive),
                autosave: Effect.void,
                flush: Effect.void,
                restoreDependencyEdits: Effect.void,
                saveNow: Effect.fail(new RunnerGitError({ message: "file store unavailable" })),
                changed: Effect.sync(() => changed),
              } as unknown as RunnerDrive;
              const turns = yield* makeRunnerTurns({
                threadId,
                adapters: new Map([[instanceId, fake.adapter]]),
                cwd: "/tmp",
                useModelToken: () => Effect.void,
                usage: countingUsage(),
                emit: (item) =>
                  Effect.gen(function* () {
                    reported.push(item);
                    if (item.kind === "turn.started") yield* Deferred.succeed(started, undefined);
                    if (item.kind === "turn.failed")
                      yield* Deferred.succeed(failedHandoff, undefined);
                    if (item.kind === "usage" && item.runId === null) {
                      yield* Deferred.succeed(idleUsage, undefined);
                    }
                    if (item.kind === "drive.notice" && item.runId === RunId.make("run-2")) {
                      yield* Deferred.succeed(nextNotice, undefined);
                    }
                  }),
                openDrive: () => Effect.succeed(drive),
                machineClass: "light",
              });
              yield* Deferred.succeed(fake.loaded, undefined);
              yield* turns.start({
                turn: turnFor(1),
                modelToken: "token-1",
                drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
              });
              yield* Deferred.await(started);
              yield* Queue.offer(fake.events, providerTurnStarted(1));
              yield* Queue.offer(
                fake.events,
                previewServiceStart("running", "mcp__signalbox__preview_service_start"),
              );
              yield* Deferred.await(failedHandoff);

              const failed = reported.find((item) => item.kind === "turn.failed");
              expect(failed?.kind === "turn.failed" ? failed.runId : null).toBe(
                RunId.make("run-1"),
              );
              expect(failed?.kind === "turn.failed" ? failed.message : "").toContain(
                "could not move to a larger machine because its state could not be saved",
              );
              expect(reported.some((item) => item.kind === "machine.outgrown")).toBe(false);

              yield* Queue.offer(fake.events, turnEnded(1));
              changed = true;
              yield* TestClock.adjust("5 minutes");
              yield* Deferred.await(idleUsage);

              expect(reported.map(label)).toContain("usage null 2");
              expect(reported.map(label)).not.toContain("usage run-1 2");
              expect(
                reported.some(
                  (item) => item.kind === "drive.notice" && item.runId === RunId.make("run-1"),
                ),
              ).toBe(false);

              yield* turns.start({
                turn: turnFor(2),
                modelToken: "token-2",
                drive: { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: null },
              });
              yield* Deferred.await(nextNotice);

              const notice = reported.find((item) => item.kind === "drive.notice");
              expect(notice?.kind === "drive.notice" ? notice.runId : null).toBe(
                RunId.make("run-2"),
              );
              expect(notice?.kind === "drive.notice" ? notice.message : "").toContain(
                "Saving this thread's latest changes failed",
              );
            }),
          ),
      );

      it.effect("saves everything, then hands a build to a heavy machine and drops the rest", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, log, handedOff } = yield* lightTurn("light");
            yield* Queue.offer(fake.events, command("running", "sed -n 1,5p notes.md"));
            yield* Queue.offer(fake.events, command("running", "/bin/bash -lc 'npm run build'"));
            yield* Queue.offer(fake.events, command("completed", "npm run build"));
            yield* Queue.offer(fake.events, turnEnded(1));
            yield* Deferred.await(handedOff);

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

      it.effect("saves before handing a preview service start to a heavy machine", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, log, handedOff } = yield* lightTurn("light");
            yield* Queue.offer(
              fake.events,
              previewServiceStart("running", "mcp__signalbox__preview_service_start"),
            );
            yield* Deferred.await(handedOff);

            expect(log).toEqual([
              "settle turn_item.updated",
              "emit turn_item.updated",
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

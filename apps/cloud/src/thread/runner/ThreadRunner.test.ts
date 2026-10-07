// @effect-diagnostics nodeBuiltinImport:off - the eviction test needs a database file that outlives one engine.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerItem,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../../testing.ts";
import { HARNESS_MODES_UNSUPPORTED } from "../threadDecider.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadRunner from "./ThreadRunner.ts";

const owner = { userId: "user_1" };
const personal = { contextId: PERSONAL_CONTEXT_ID };
const threadId = ThreadId.make("thread-claude");
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-fable-5-1" };
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-runner-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

/** The object on `filename`; each call is the object waking up again. */
const withObject = <A, E>(
  filename: string,
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    runner: ThreadRunner.ThreadRunner["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(filename)).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadRunner.ThreadRunner),
        ),
      ),
    ),
  );

const launch = (engine: ThreadEngine.ThreadEngine["Service"], commandId = "launch-1") =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make(commandId),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Hello Claude",
      modelSelection: claude,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
    },
    personal,
  );

const hello = (generation: number, token: string) => ({
  type: "hello" as const,
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  imageVersion: "test",
  machineId: "machine-1",
  threadId,
  generation,
  token,
  lastAckedSequence: 0,
});

const off = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.keys(fields).map((key) => [key, false])) as {
    readonly [K in keyof T]: false;
  };

const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: off({
    supportsMultipleProviderThreadsPerSession: 0,
    supportsModelSwitchInSession: 0,
    supportsProviderSwitchingViaHandoff: 0,
    supportsRuntimeModeSwitchInSession: 0,
    pendingRequestsSurviveRestart: 0,
  }),
  threads: off({
    canCreateEmptyThread: 0,
    canReadThreadSnapshot: 0,
    canRollbackThread: 0,
    canForkThread: 0,
    canForkFromTurn: 0,
    canForkFromSubagentThread: 0,
    exposesNativeThreadId: 0,
  }),
  turns: {
    ...off({
      exposesNativeTurnId: 0,
      emitsTurnStarted: 0,
      emitsTurnCompleted: 0,
      supportsInterrupt: 0,
      supportsActiveSteering: 0,
      supportsSteeringByInterruptRestart: 0,
      supportsQueuedMessages: 0,
    }),
    terminalStatusQuality: "strong",
  },
  streaming: off({
    streamsAssistantText: 0,
    streamsReasoning: 0,
    streamsToolOutput: 0,
    streamsPlanText: 0,
    emitsMessageCompleted: 0,
  }),
  tools: off({
    exposesToolItemIds: 0,
    emitsToolStarted: 0,
    emitsToolCompleted: 0,
    emitsToolOutput: 0,
    supportsMcpTools: 0,
    supportsDynamicToolCallbacks: 0,
  }),
  approvals: off({
    supportsCommandApproval: 0,
    supportsFileReadApproval: 0,
    supportsFileChangeApproval: 0,
    supportsApplyPatchApproval: 0,
    approvalsHaveNativeRequestIds: 0,
    approvalCallbacksAreLiveOnly: 0,
    approvalsCanOriginateFromSubagents: 0,
  }),
  planning: off({
    emitsPlanUpdated: 0,
    emitsTodoList: 0,
    emitsProposedPlan: 0,
    supportsStructuredQuestions: 0,
    planDeltasHaveItemIds: 0,
  }),
  subagents: off({
    supportsSubagents: 0,
    exposesSubagentThreadIds: 0,
    emitsSubagentLifecycle: 0,
    canWaitForSubagents: 0,
    canCloseSubagents: 0,
    canForkSubagentThread: 0,
  }),
  context: {
    ...off({
      acceptsSystemContext: 0,
      acceptsDeveloperContext: 0,
      acceptsSyntheticUserContext: 0,
      canGenerateSummaries: 0,
      canConsumeHandoffSummaries: 0,
      supportsDeltaHandoff: 0,
      supportsFullThreadHandoff: 0,
    }),
    maxRecommendedHandoffChars: null,
  },
  checkpointing: off({
    appCanCheckpointFilesystem: 0,
    supportsNestedCheckpointScopes: 0,
    providerCanRollbackConversation: 0,
    providerRollbackReturnsSnapshot: 0,
    providerCanReadConversationSnapshot: 0,
  }),
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
};

const now = DateTime.makeUnsafe(0);
const encodeTurnItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
const encodeProviderThread = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ProviderThread));

/** What a Runner reports for one Claude turn: started, a streamed reply, done. */
const turnReport = (
  runId: RunId,
  runOrdinal: number,
  providerThread: OrchestrationV2ProviderThread,
) => {
  const reply = (text: string, done: boolean) =>
    encodeTurnItem({
      id: TurnItemId.make(`claude-item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: ProviderTurnId.make(`claude-turn:${runId}`),
      nativeItemRef: null,
      parentItemId: null,
      // Whatever the adapter picks; the thread places it in the run's band.
      ordinal: 7,
      status: done ? "completed" : "running",
      title: null,
      startedAt: now,
      completedAt: done ? now : null,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`claude-message:${runId}`),
      text,
      streaming: !done,
    });
  const provider = (event: Record<string, unknown>): RunnerItem => ({
    kind: "provider",
    runId,
    event: { driver: claudeDriver, ...event },
  });
  return {
    started: {
      kind: "turn.started",
      runId,
      providerSession: {
        id: ProviderSessionId.make("session-1"),
        driver: claudeDriver,
        providerInstanceId: claude.instanceId,
        status: "running",
        cwd: "/tmp/thread",
        model: claude.model,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      providerThread: {
        ...providerThread,
        nativeThreadRef: { driver: claudeDriver, nativeId: "claude-session-1", strength: "strong" },
      },
    } satisfies RunnerItem,
    partial: provider({ type: "turn_item.updated", turnItem: reply("Hel", false) }),
    full: provider({ type: "turn_item.updated", turnItem: reply("Hello!", true) }),
    terminal: provider({
      type: "turn.terminal",
      providerThreadId: providerThread.id,
      providerTurnId: `claude-turn:${runId}`,
      runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    }),
  };
};

/** Asks for a machine and connects its Runner. Returns the generation. */
const connect = (runner: ThreadRunner.ThreadRunner["Service"]) =>
  Effect.gen(function* () {
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);
    const welcome = yield* runner.hello(hello(plan.ensure.generation, plan.ensure.token));
    expect(welcome._tag).toBe("welcome");
    return plan.ensure;
  });

const liveTurn = (runner: ThreadRunner.ThreadRunner["Service"]) =>
  Effect.map(runner.work, (work) => {
    if (work.turn === null) throw new Error("expected a turn for the Runner");
    return work.turn;
  });

const snapshot = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), ({ snapshotSequence, projection }) => ({
    head: snapshotSequence,
    projection,
  }));

describe("ThreadRunner", () => {
  it.effect("answers for a thread that does not exist without touching storage", () =>
    withObject(freshDatabase(), (_engine, runner) =>
      Effect.gen(function* () {
        expect(yield* runner.work).toMatchObject({ needsUpkeep: false, turn: null });
        expect((yield* runner.reconcile).ensure).toBeNull();
        expect(yield* runner.hello(hello(1, "token"))).toMatchObject({ reason: "unknown_thread" });
      }),
    ),
  );

  it.effect("streams a Runner's turn into the thread and starts nothing twice", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        expect(turn.providerThread.nativeThreadRef).toBeNull();
        expect(turn.message.text).toBe("Hi");
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        const batch = (sequence: number, items: ReadonlyArray<RunnerItem>) =>
          runner.batch({ generation: machine.generation, sequence, items });

        expect(yield* batch(1, [report.started])).toEqual({ _tag: "ack", sequence: 1 });
        // Started: no turn left to hand out.
        expect((yield* runner.work).turn).toBeNull();
        expect(yield* batch(2, [report.partial])).toEqual({ _tag: "ack", sequence: 2 });
        const midTurn = yield* snapshot(engine);

        // The socket dropped before the ack arrived: the Runner resends batch 2.
        expect(yield* batch(2, [report.partial])).toEqual({ _tag: "ack", sequence: 2 });
        expect((yield* snapshot(engine)).head).toBe(midTurn.head);
        // A gap is never applied.
        expect(yield* batch(4, [report.full])).toEqual({ _tag: "out_of_order", ackedSequence: 2 });

        yield* batch(3, [report.full, report.terminal]);
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
        expect(projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("claude-session-1");
        expect(projection.providerThreads[0]?.status).toBe("idle");
        const rows = projection.visibleTurnItems.map(({ item }) => item);
        expect(rows.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
        expect(rows.map((item) => item.ordinal)).toEqual([1_000_000, 1_000_001]);
        expect(rows[1]).toMatchObject({ text: "Hello!", status: "completed" });
      }),
    ),
  );

  it.effect("keeps acknowledged batches across an eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const { machine, turn, head } = yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [report.partial],
          });
          return { machine, turn, head: (yield* snapshot(engine)).head };
        }),
      );
      yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          const welcome = yield* runner.hello(hello(machine.generation, machine.token));
          expect(welcome).toMatchObject({
            _tag: "welcome",
            ackedSequence: 2,
            activeRunId: turn.runId,
          });
          // Everything the Runner still holds is resent; only what is new lands.
          for (const [sequence, items] of [
            [1, [report.started]],
            [2, [report.partial]],
          ] as const) {
            yield* runner.batch({ generation: machine.generation, sequence, items });
          }
          expect((yield* snapshot(engine)).head).toBe(head);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 3,
            items: [report.full, report.terminal],
          });
          const { projection } = yield* snapshot(engine);
          expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
          expect(
            projection.turnItems.filter((item) => item.type === "assistant_message"),
          ).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("refuses a Runner from an older generation", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        // The machine went away; the next message gets a new one.
        yield* runner.ended(first.generation);
        yield* engine.dispatch(
          owner,
          {
            type: "message.dispatch",
            commandId: CommandId.make("send-2"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make("message-2"),
            text: "Again",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          },
          personal,
        );
        const second = yield* connect(runner);
        expect(second.generation).toBe(first.generation + 1);

        expect(yield* runner.hello(hello(first.generation, first.token))).toMatchObject({
          _tag: "refused",
          reason: "stale_generation",
        });
        expect(yield* runner.hello(hello(second.generation, first.token))).toMatchObject({
          _tag: "refused",
          reason: "bad_token",
        });
        expect(yield* runner.hello(hello(second.generation + 1, second.token))).toMatchObject({
          _tag: "refused",
          reason: "unknown_generation",
        });
        // A socket left over from the old generation cannot write either.
        expect(
          yield* runner.batch({ generation: first.generation, sequence: 2, items: [report.full] }),
        ).toEqual({ _tag: "stale" });
      }),
    ),
  );

  it.effect("fails the run when no machine connects, and lets the next message try again", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const plan = yield* runner.reconcile;
        expect(plan.ensure?.generation).toBe(1);
        yield* TestClock.adjust(ThreadRunner.CONNECT_TIMEOUT_MS + 1);
        const timedOut = yield* runner.reconcile;
        expect(timedOut.release).toBe(1);

        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["failed"]);
        const error = projection.turnItems.find((item) => item.type === "error");
        expect(error).toMatchObject({
          failure: { message: "No machine came up to run this turn." },
        });
        expect(yield* runner.hello(hello(1, plan.ensure?.token ?? ""))).toMatchObject({
          reason: "stale_generation",
        });
      }),
    ),
  );

  it.effect("releases an idle machine after its tail", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        const idle = yield* runner.reconcile;
        expect(idle.release).toBeNull();
        expect(idle.wakeAt).toBe(ThreadRunner.IDLE_TAIL_MS);
        yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS);
        expect((yield* runner.reconcile).release).toBe(machine.generation);
        expect((yield* runner.work).needsUpkeep).toBe(false);
      }),
    ),
  );

  it.effect("ignores the late close of a connection a reconnect replaced", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const again = yield* runner.hello(hello(machine.generation, machine.token));
        if (again._tag !== "welcome") throw new Error("expected a welcome");
        // The first socket's close arrives after the second said hello.
        yield* runner.disconnected({
          generation: machine.generation,
          connection: again.connection - 1,
        });
        expect((yield* runner.work).needsUpkeep).toBe(false);
        yield* runner.disconnected({
          generation: machine.generation,
          connection: again.connection,
        });
        expect((yield* runner.work).needsUpkeep).toBe(true);
      }),
    ),
  );

  it.effect(
    "fails the live run when its machine says end, and ignores the run's late session state",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* runner.ended(machine.generation);

          const ended = yield* snapshot(engine);
          expect(ended.projection.runs.map((run) => run.status)).toEqual(["failed"]);
          expect(ended.projection.providerThreads[0]?.status).toBe("idle");
          expect(yield* runner.hello(hello(machine.generation, machine.token))).toMatchObject({
            reason: "stale_generation",
          });
        }),
      ),
  );

  it.effect("records a stopped run's last rows but not its provider thread coming back", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started],
        });
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop-1"),
            threadId,
            runId: turn.runId,
            holdQueue: true,
          },
          personal,
        );
        const lateThread: RunnerItem = {
          kind: "provider",
          runId: turn.runId,
          event: {
            type: "provider_thread.updated",
            driver: claudeDriver,
            providerThread: encodeProviderThread({
              ...turn.providerThread,
              status: "active",
            }),
          },
        };
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [report.full, lateThread],
        });
        const { projection } = yield* snapshot(engine);
        expect(projection.runs.map((run) => run.status)).toEqual(["interrupted"]);
        expect(projection.providerThreads[0]?.status).toBe("idle");
        expect(
          projection.turnItems.find((item) => item.type === "assistant_message"),
        ).toMatchObject({ text: "Hello!" });
      }),
    ),
  );

  it.effect("refuses a Claude turn that could stop to ask for approval", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          engine.launch(
            owner,
            {
              commandId: CommandId.make("launch-approval"),
              threadId,
              projectId: ProjectId.make("scratch"),
              title: "Ask first",
              modelSelection: claude,
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make("message-1"),
                text: "Hi",
                attachments: [],
              },
            },
            personal,
          ),
        );
        expect(refused).toMatchObject({ reason: HARNESS_MODES_UNSUPPORTED });
      }),
    ),
  );
});

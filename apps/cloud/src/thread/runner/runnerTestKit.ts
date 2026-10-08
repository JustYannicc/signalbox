// @effect-diagnostics nodeBuiltinImport:off - tests need database files that outlive one engine.
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
import { afterEach, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { layerThreadObject } from "../../testing.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadRunner from "./ThreadRunner.ts";

/** A Claude thread's object with its Runner, and what a Runner reports, for tests. */

export const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
export const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
};
export const threadId = ThreadId.make("thread-claude");
export const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-1",
};
export const claudeDriver = ProviderDriverKind.make("claudeAgent");

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

export const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-runner-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

/** What the object's previews tell the lease; tests flip it by hand. */
export interface Previews {
  held: boolean;
  lastActiveAt: number | null;
}

/**
 * The object on `filename`; each call is the object waking up again. `use`
 * also gets the object's whole context, for its other services.
 */
export const withObject = <A, E>(
  filename: string,
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    runner: ThreadRunner.ThreadRunner["Service"],
    context: Context.Context<Layer.Success<ReturnType<typeof layerThreadObject>>>,
  ) => Effect.Effect<A, E>,
  options: Parameters<typeof layerThreadObject>[2] & { readonly previews?: Previews } = {},
) =>
  Effect.scoped(
    Layer.build(
      layerThreadObject(filename, undefined, options).pipe(
        Layer.provide(
          Layer.succeed(ThreadRunner.PreviewHold, {
            held: Effect.sync(() => options.previews?.held ?? false),
            lastActiveAt: Effect.sync(() => options.previews?.lastActiveAt ?? null),
          }),
        ),
      ),
    ).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadRunner.ThreadRunner),
          context,
        ),
      ),
    ),
  );

export const launch = (
  engine: ThreadEngine.ThreadEngine["Service"],
  commandId = "launch-1",
  creation: ThreadEngine.ThreadCreation = personal,
) =>
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
    creation,
  );

export const hello = (generation: number, token: string) => ({
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

export const capabilities: OrchestrationV2ProviderCapabilities = {
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

export const now = DateTime.makeUnsafe(0);
export const encodeTurnItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
export const encodeProviderThread = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2ProviderThread),
);

/** What a Runner reports for one Claude turn: started, a streamed reply, done. */
export const turnReport = (
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
export const connect = (runner: ThreadRunner.ThreadRunner["Service"]) =>
  Effect.gen(function* () {
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);
    const welcome = yield* runner.hello(hello(plan.ensure.generation, plan.ensure.token));
    expect(welcome._tag).toBe("welcome");
    return plan.ensure;
  });

export const liveTurn = (runner: ThreadRunner.ThreadRunner["Service"]) =>
  Effect.map(runner.work, (work) => {
    if (work.turn === null) throw new Error("expected a turn for the Runner");
    return work.turn;
  });

export const snapshot = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), ({ snapshotSequence, projection }) => ({
    head: snapshotSequence,
    projection,
  }));

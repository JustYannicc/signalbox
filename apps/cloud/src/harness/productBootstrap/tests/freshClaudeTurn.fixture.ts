import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const freshClaudeTurnData = () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const driver = ProviderDriverKind.make("claudeAgent");
    const threadId = ThreadId.make("fresh-claude-thread");
    const instanceId = ProviderInstanceId.make("fresh-claude-handoff");
    const providerSessionId = ProviderSessionId.make("fresh-claude-session");
    const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
    const providerThread: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make("fresh-claude-provider-thread"),
      driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: now,
      updatedAt: now,
    };
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("fresh-claude-project"),
      title: "Fresh Claude handoff",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const turn: RunnerTurn = {
      preparationGeneration: 1,
      threadId,
      runId: RunId.make("fresh-claude-first-turn"),
      traceId: "0".repeat(32),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("fresh-claude-first-attempt"),
      rootNodeId: NodeId.make("fresh-claude-root"),
      appThread,
      providerThread,
      message: {
        messageId: MessageId.make("fresh-claude-first-message"),
        text: "First fresh Claude turn",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const systemIdentity = systemIdentityForThread(threadId, {
      release: "6.12.8-test",
      version: "#1 SMP PREEMPT_DYNAMIC",
      machine: "aarch64",
      hostnamePolicy: "thread",
      verification: "measured",
    });
    return {
      systemIdentity,
      driver,
      threadId,
      instanceId,
      providerSessionId,
      modelSelection,
      providerThread,
      turn,
    };
  });

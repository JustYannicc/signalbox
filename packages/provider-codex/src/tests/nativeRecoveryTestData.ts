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
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

export function recoveryTurn(): ProviderAdapterV2TurnInput {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const threadId = ThreadId.make("thread");
  const now = DateTime.makeUnsafe(0);
  const providerThread = {
    id: ProviderThreadId.make("provider-thread"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("provider-session"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" as const },
    nativeConversationHeadRef: null,
    status: "idle" as const,
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
  const modelSelection = { instanceId, model: "model" };
  return {
    threadId,
    runId: RunId.make("logical-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("replacement-attempt"),
    rootNodeId: NodeId.make("root"),
    providerThread,
    modelSelection,
    runtimePolicy: { cwd: "/workspace", runtimeMode: "full-access", interactionMode: "default" },
    message: {
      messageId: MessageId.make("message"),
      text: "ORIGINAL PROMPT MUST NOT BE REOFFERED",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Recovery",
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
    },
  };
}

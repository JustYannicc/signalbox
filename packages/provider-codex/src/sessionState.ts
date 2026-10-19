import type {
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { type CodexDynamicToolItem } from "./nativeItems.ts";

export interface ActiveCodexTurnContext {
  latestProviderFailure?: {
    readonly nativeMessage: string;
    readonly failure: OrchestrationV2ProviderFailure;
  };
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly projectionAppThread: OrchestrationV2AppThread;
  readonly projectionThreadId: ThreadId;
  readonly projectionRunId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly nativeTurnId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly providerNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerNodeKind: OrchestrationV2ExecutionNode["kind"];
  readonly providerNodeStartedAt: DateTime.Utc | null;
  readonly itemParentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly subagent: CodexSubagentThreadContext | null;
  readonly startedAt: DateTime.Utc;
  readonly itemPositions: Map<
    string,
    { readonly ordinal: number; readonly startedAt: DateTime.Utc }
  >;
}

export interface ActiveCodexProviderRetry {
  readonly nativeMessage: string;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

export interface TrackedRunningCommandItem {
  readonly id: string;
  readonly command: string;
  readonly aggregatedOutput?: string;
  readonly processId?: string;
}

export function isPersistentCodexDynamicTool(item: CodexDynamicToolItem): boolean {
  const input = item.arguments;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

export type CodexRootTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

export interface CodexGoalHold {
  readonly context: ActiveCodexTurnContext;
  readonly event: Extract<CodexRootTerminalEvent, { readonly failure: null }>;
  readonly completedTurn: OrchestrationV2ProviderTurn;
  readonly next: Deferred.Deferred<ActiveCodexTurnContext | undefined>;
}

export interface DeferredCodexRootTerminal {
  readonly context: ActiveCodexTurnContext;
  readonly event: CodexRootTerminalEvent;
}

export interface CodexSubagentThreadContext {
  parentContext: ActiveCodexTurnContext;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly childThread: OrchestrationV2AppThread;
  readonly subagentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThreadId: ThreadId;
  readonly nativeToolCallId: string;
  readonly ordinal: number;
  readonly nativeTurnIds: Set<string>;
  startedAt: DateTime.Utc;
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  task: OrchestrationV2Subagent;
}

export const approvalOwnerCodexTurn = (
  context: ActiveCodexTurnContext,
): {
  readonly owner: ActiveCodexTurnContext;
  readonly subagent: CodexSubagentThreadContext | null;
} => {
  let owner = context;
  let subagent: CodexSubagentThreadContext | null = null;
  while (owner.subagent !== null) {
    subagent = owner.subagent;
    owner = owner.subagent.parentContext;
  }
  return { owner, subagent };
};

export const isDescendantCodexTurn = (
  candidate: ActiveCodexTurnContext,
  ancestor: ActiveCodexTurnContext,
): boolean => {
  let parent = candidate.subagent?.parentContext;
  while (parent !== undefined) {
    if (parent === ancestor) {
      return true;
    }
    parent = parent.subagent?.parentContext;
  }
  return false;
};

export interface PendingCodexSubagentTurnStarted {
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
}

export type PendingCodexRuntimeRequest =
  | {
      readonly type: "approval";
      readonly requestId: RuntimeRequestId;
      readonly requestKind: ProviderRequestKind;
      readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
    }
  | {
      readonly type: "user_input";
      readonly requestId: RuntimeRequestId;
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
    };

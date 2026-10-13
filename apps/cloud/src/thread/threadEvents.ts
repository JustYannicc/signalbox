import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/**
 * Event constructors and the ids a cloud thread derives for its records. Ids
 * are derived from the thread and run, never random, so a decision repeated
 * after a crash names the same records.
 */

export interface DecisionContext {
  readonly now: DateTime.Utc;
}

/**
 * Decisions stay deterministic, so events leave the decider with this id and
 * the engine stamps a fresh one on each before it commits them.
 */
const UNSTAMPED_EVENT_ID = EventId.make("unstamped");

/** Marks an event the engine has not stamped yet. */
export const unstampedEventId = UNSTAMPED_EVENT_ID;

export const ids = {
  run: (threadId: ThreadId, ordinal: number) => RunId.make(`run:${threadId}:${ordinal}`),
  attempt: (runId: RunId) => RunAttemptId.make(`attempt:${runId}:1`),
  rootNode: (runId: RunId) => NodeId.make(`node:${runId}:root`),
  userItem: (runId: RunId) => TurnItemId.make(`turn-item:${runId}:user`),
  assistantItem: (runId: RunId) => TurnItemId.make(`turn-item:${runId}:assistant`),
  assistantMessage: (runId: RunId) => MessageId.make(`message:${runId}:assistant`),
  providerThread: (threadId: ThreadId) => ProviderThreadId.make(`provider-thread:${threadId}`),
};

/** Turn items sort by run, then by position within the run, like upstream's ordinal bands. */
export const itemOrdinal = (runOrdinal: number, position: number) =>
  runOrdinal * 1_000_000 + position;

type ThreadEventType = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>["type"];

const base = (ctx: DecisionContext, threadId: ThreadId) => ({
  id: UNSTAMPED_EVENT_ID,
  threadId,
  occurredAt: ctx.now,
});

export const threadEvent = (
  ctx: DecisionContext,
  type: ThreadEventType,
  thread: OrchestrationV2AppThread,
): OrchestrationV2DomainEvent =>
  ({
    ...base(ctx, thread.id),
    providerInstanceId: thread.providerInstanceId,
    type,
    payload: thread,
  }) as OrchestrationV2DomainEvent;

export const runEvent = (
  ctx: DecisionContext,
  type: "run.created" | "run.updated",
  run: OrchestrationV2Run,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, run.threadId),
  runId: run.id,
  providerInstanceId: run.providerInstanceId,
  type,
  payload: run,
});

export const attemptEvent = (
  ctx: DecisionContext,
  threadId: ThreadId,
  type: "run-attempt.created" | "run-attempt.updated",
  attempt: OrchestrationV2RunAttempt,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, threadId),
  runId: attempt.runId,
  nodeId: attempt.rootNodeId,
  providerInstanceId: attempt.providerInstanceId,
  type,
  payload: attempt,
});

export const nodeEvent = (
  ctx: DecisionContext,
  node: OrchestrationV2ExecutionNode,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, node.threadId),
  ...(node.runId === null ? {} : { runId: node.runId }),
  nodeId: node.id,
  type: "node.updated",
  payload: node,
});

export const providerThreadEvent = (
  ctx: DecisionContext,
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, threadId),
  driver: providerThread.driver,
  providerInstanceId: providerThread.providerInstanceId,
  type: "provider-thread.updated",
  payload: providerThread,
});

export const providerSessionEvent = (
  ctx: DecisionContext,
  threadId: ThreadId,
  providerSession: OrchestrationV2ProviderSession,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, threadId),
  driver: providerSession.driver,
  providerInstanceId: providerSession.providerInstanceId,
  type: "provider-session.updated",
  payload: providerSession,
});

export const messageEvent = (
  ctx: DecisionContext,
  message: OrchestrationV2ConversationMessage,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, message.threadId),
  ...(message.runId === null ? {} : { runId: message.runId }),
  type: "message.updated",
  payload: message,
});

export const turnItemEvent = (
  ctx: DecisionContext,
  item: OrchestrationV2TurnItem,
): OrchestrationV2DomainEvent => ({
  ...base(ctx, item.threadId),
  ...(item.runId === null ? {} : { runId: item.runId }),
  ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
  type: "turn-item.updated",
  payload: item,
});

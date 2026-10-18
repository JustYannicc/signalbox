import { onFreshSession, type RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  ContextHandoffId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  TurnItemId,
} from "@t3tools/contracts";
import {
  handoffBudget,
  handoffCoverage,
  historicalMessage,
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

import {
  type DecisionContext,
  runEvent,
  turnItemEvent,
  unstampedEventId,
} from "../threadEvents.ts";

type Turn = Omit<RunnerTurn, "traceId">;
type Projection = OrchestrationV2ThreadProjection;

/** A loaded session is not proof that its first prompt reached the provider. */
export function hasUnconfirmedHandoff(projection: Projection, turn: Turn): boolean {
  const previous = projection.runs
    .filter(
      (run) => run.ordinal < turn.runOrdinal && run.providerThreadId === turn.providerThread.id,
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const handoff = projection.contextHandoffs.find(
    (candidate) => candidate.id === previous?.contextHandoffId,
  );
  return (
    previous !== undefined &&
    (previous.status === "failed" || previous.status === "interrupted") &&
    handoff !== undefined &&
    handoff.status !== "superseded" &&
    handoff.delivery?.status === "inline" &&
    // Claude announces its provider turn before offering the prompt to the query.
    !projection.turnItems.some(
      (item) =>
        item.runId === previous.id &&
        (item.type === "command_execution" ||
          (item.type === "assistant_message" && item.text !== "")),
    )
  );
}

const handoffEvent = (
  handoff: OrchestrationV2ContextHandoff,
  ctx: DecisionContext,
): OrchestrationV2DomainEvent => ({
  id: unstampedEventId,
  threadId: handoff.threadId,
  runId: handoff.targetRunId,
  type: "context-handoff.updated",
  occurredAt: ctx.now,
  payload: handoff,
});

/** Prepare once under the thread lock, including the fallback for a native resume that fails. */
export function prepareFreshSession(
  projection: Projection,
  turn: Turn,
  ctx: DecisionContext,
  tokenCap: number,
  fresh: boolean,
):
  | {
      readonly _tag: "ready";
      readonly turn: Turn;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    }
  | { readonly _tag: "refused"; readonly message: string } {
  const run = projection.runs.find((candidate) => candidate.id === turn.runId);
  const existing = projection.contextHandoffs.find(
    (candidate) =>
      candidate.targetRunId === turn.runId &&
      candidate.toProviderThreadId === turn.providerThread.id,
  );
  const rootNodes = new Set([null, ...projection.runs.map((candidate) => candidate.rootNodeId)]);
  const previousRuns = projection.runs.filter((candidate) => candidate.ordinal < turn.runOrdinal);
  const runsById = new Map(previousRuns.map((candidate) => [candidate.id, candidate]));
  const items = projection.turnItems
    .filter((item) => item.runId !== null && runsById.has(item.runId) && rootNodes.has(item.nodeId))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (run === undefined || items.length === 0) {
    return {
      _tag: "ready",
      turn: fresh ? onFreshSession(turn, turn.message.text) : turn,
      events: [],
    };
  }
  let handoff = existing;
  if (handoff === undefined) {
    const coveredRunOrdinals = {
      from: 1,
      to: previousRuns.reduce((latest, candidate) => Math.max(latest, candidate.ordinal), 1),
    };
    const coverage = handoffCoverage({ threadId: turn.threadId, coveredRunOrdinals, items });
    const messages = items.flatMap((item) => {
      const message = historicalMessage(item);
      const source = item.runId === null ? undefined : runsById.get(item.runId);
      return message === null
        ? []
        : [{ ...message, ...(source === undefined ? {} : { runStatus: source.status }) }];
    });
    const budget = handoffBudget({
      tokenCap,
      userText: turn.message.text,
      attachments: turn.message.attachments,
      // This is imported into an empty native session, even when prepared as a resume fallback.
      providerThread: { ...turn.providerThread, contextUsage: null },
      nativeContextEstimate: 0,
    });
    const selected = selectHistory({
      messages,
      coverage,
      budget,
      omittedItems: items.length - messages.length,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (!fresh) return { _tag: "ready", turn, events: [] };
      return {
        _tag: "refused",
        message:
          "There isn't enough context space to carry this conversation. Send a shorter message or fewer attachments.",
      };
    }
    handoff = {
      id: ContextHandoffId.make(`context-handoff:${turn.runId}`),
      threadId: turn.threadId,
      targetRunId: turn.runId,
      fromProviderThreadIds: [
        ...new Set(
          items.flatMap((item) => (item.providerThreadId == null ? [] : [item.providerThreadId])),
        ),
      ],
      toProviderThreadId: turn.providerThread.id,
      coveredRunOrdinals,
      strategy: "full_thread_summary",
      status: "ready",
      summaryMessageId: null,
      summaryText: renderHistory(selected.messages, selected.context),
      history: {
        messages: selected.messages,
        coverage: selected.context,
        omittedItems: selected.omittedItems,
        omittedItemIds: selected.omittedItemIds,
      },
      createdByProviderInstanceId: run.providerInstanceId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
  }
  const text = `Context handoff (${handoff.strategy}):\n${handoff.summaryText}\n\nUser message:\n${turn.message.text}`;
  // A fallback that native resume never uses must not grow durable thread history.
  if (!fresh) return { _tag: "ready", turn: { ...turn, freshSessionText: text }, events: [] };
  if (
    handoff.status !== "ready" ||
    handoff.delivery?.nativeThreadId !== "" ||
    handoff.delivery.status !== "pending"
  ) {
    handoff = {
      ...handoff,
      status: "ready",
      delivery: {
        nativeThreadId: "",
        status: "pending",
        itemIds: handoff.history?.messages.map((message) => message.itemId) ?? [],
      },
      updatedAt: ctx.now,
    };
  }
  return {
    _tag: "ready",
    turn: onFreshSession(turn, text),
    events: [
      ...(handoff === existing ? [] : [handoffEvent(handoff, ctx)]),
      ...(run.contextHandoffId === handoff.id
        ? []
        : [runEvent(ctx, "run.updated", { ...run, contextHandoffId: handoff.id })]),
    ],
  };
}

/** The loaded session tells us whether the Runner used the inline history or resumed natively. */
export function deliveredHandoffEvents(
  projection: Projection,
  run: OrchestrationV2Run,
  providerThread: OrchestrationV2ProviderThread,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const handoff = projection.contextHandoffs.find(
    (candidate) => candidate.id === run.contextHandoffId,
  );
  if (handoff === undefined || handoff.delivery?.status !== "pending") return [];
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId ?? "";
  if (
    handoff.delivery.nativeThreadId !== "" &&
    handoff.delivery.nativeThreadId === nativeThreadId
  ) {
    return [handoffEvent({ ...handoff, status: "superseded", updatedAt: ctx.now }, ctx)];
  }
  const itemId = TurnItemId.make(`turn-item:${run.id}:handoff`);
  const sources = projection.providerThreads.filter((candidate) =>
    handoff.fromProviderThreadIds.includes(candidate.id),
  );
  return [
    handoffEvent(
      {
        ...handoff,
        delivery: { ...handoff.delivery, nativeThreadId, status: "inline" },
        updatedAt: ctx.now,
      },
      ctx,
    ),
    turnItemEvent(ctx, {
      id: itemId,
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal:
        projection.turnItems.reduce(
          (latest, item) => (item.runId === run.id ? Math.max(latest, item.ordinal) : latest),
          run.ordinal * 1_000_000,
        ) + 1,
      type: "handoff",
      status: "completed",
      title: "Context handoff",
      startedAt: ctx.now,
      completedAt: ctx.now,
      updatedAt: ctx.now,
      contextHandoffId: handoff.id,
      fromProviderThreadIds: handoff.fromProviderThreadIds,
      toProviderThreadId: providerThread.id,
      fromProviderInstanceIds: [...new Set(sources.map((source) => source.providerInstanceId))],
      toProviderInstanceId: run.providerInstanceId,
      toModel: run.modelSelection.model,
      strategy: handoff.strategy,
      summary: handoff.summaryText,
    }),
  ];
}

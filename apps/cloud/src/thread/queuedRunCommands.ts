import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { messageEvent, runEvent, turnItemEvent, type DecisionContext } from "./threadEvents.ts";

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

export type QueuedRunCommandDecision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }
  | { readonly _tag: "rejected"; readonly message: string };

const accept = (events: ReadonlyArray<OrchestrationV2DomainEvent>): QueuedRunCommandDecision => ({
  _tag: "accepted",
  events,
});

const reject = (message: string): QueuedRunCommandDecision => ({
  _tag: "rejected",
  message,
});

export function isAutomaticCompletionRun(
  projection: Pick<Projection, "runs" | "messages">,
  run: Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

/** Queue order is stored on each run so every client and the runner can agree after a reorder. */
export function queuedRunsInDeliveryOrder(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

function reorder(
  projection: Projection,
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
  ctx: DecisionContext,
): QueuedRunCommandDecision {
  const queuedRuns = queuedRunsInDeliveryOrder(projection);
  const moving = queuedRuns.find((run) => run.id === command.runId);
  if (moving === undefined) return reject(`Run ${command.runId} is not queued.`);

  const movingMessage = projection.messages.find(
    (candidate) => candidate.id === moving.userMessageId,
  );
  if (
    movingMessage?.delegatedCompletion !== undefined ||
    movingMessage?.notification !== undefined
  ) {
    return reject("Automatic completion deliveries cannot be reordered.");
  }

  const automaticRuns = queuedRuns.filter((run) => isAutomaticCompletionRun(projection, run));
  if (command.beforeRunId !== null && automaticRuns.some((run) => run.id === command.beforeRunId)) {
    return reject("Queued messages cannot be reordered ahead of automatic completion delivery.");
  }

  const reorderableRuns = queuedRuns.filter((run) => !isAutomaticCompletionRun(projection, run));
  const withoutMoving = reorderableRuns.filter((run) => run.id !== command.runId);
  const beforeIndex =
    command.beforeRunId === null
      ? withoutMoving.length
      : withoutMoving.findIndex((run) => run.id === command.beforeRunId);
  if (beforeIndex === -1) return reject(`Queue target ${command.beforeRunId} is not queued.`);

  const reordered = [
    ...automaticRuns,
    ...withoutMoving.slice(0, beforeIndex),
    moving,
    ...withoutMoving.slice(beforeIndex),
  ];
  return accept(
    reordered.flatMap((run, index) => {
      const queuePosition = index + 1;
      return run.queuePosition === queuePosition
        ? []
        : [runEvent(ctx, "run.updated", { ...run, queuePosition })];
    }),
  );
}

function edit(
  projection: Projection,
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
  ctx: DecisionContext,
): QueuedRunCommandDecision {
  if (command.text.trim().length === 0) {
    return reject(`Queued run ${command.runId} cannot be edited to an empty message.`);
  }

  const run = projection.runs.find((candidate) => candidate.id === command.runId);
  if (run === undefined || run.status !== "queued") {
    return reject(`Run ${command.runId} is not queued.`);
  }
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (message === undefined) {
    return reject(`Queued run ${run.id} has no user message.`);
  }
  if (message.delegatedCompletion !== undefined || message.notification !== undefined) {
    return reject("Automatic completion deliveries cannot be edited.");
  }

  const editedAttachments =
    command.attachments === undefined ? {} : { attachments: command.attachments };
  const editedContext = command.context === undefined ? {} : { context: command.context };
  const updatedAt = ctx.now;
  const events: Array<OrchestrationV2DomainEvent> = [
    messageEvent(ctx, {
      ...message,
      text: command.text,
      ...editedAttachments,
      ...editedContext,
      updatedAt,
    }),
  ];
  const turnItem = projection.turnItems.find(
    (candidate) => candidate.type === "user_message" && candidate.messageId === message.id,
  );
  if (turnItem?.type === "user_message") {
    events.push(
      turnItemEvent(ctx, {
        ...turnItem,
        text: command.text,
        ...editedAttachments,
        ...editedContext,
        updatedAt,
      }),
    );
  }
  return accept(events);
}

/** Handles only queue edits and reorders; the thread decider owns all other command types. */
export function decideQueuedRunCommand(
  projection: Projection,
  command: OrchestrationV2Command,
  ctx: DecisionContext,
): QueuedRunCommandDecision | undefined {
  switch (command.type) {
    case "queued-run.edit":
      return edit(projection, command, ctx);
    case "queued-run.reorder":
      return reorder(projection, command, ctx);
    default:
      return undefined;
  }
}

import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { activeRun } from "./runLifecycle.ts";
import { positionTurnItem } from "./runner/runnerEvents.ts";
import { type DecisionContext, ids, messageEvent, turnItemEvent } from "./threadEvents.ts";

/**
 * Messages the person sends into a running cloud turn (#562): which ones
 * steer it and what a steer records. Pure, like the decider. The Runner hands
 * each steer to its harness (`ThreadRunner`'s `work`), so a run can only be
 * steered while its harness runs it, on a session that says it takes steers.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;
type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/** The harness turn `run` is on right now, while it runs. */
const runningProviderTurn = (projection: Projection, run: Run) =>
  projection.providerTurns.find(
    (candidate) => candidate.runAttemptId === run.activeAttemptId && candidate.status === "running",
  );

/**
 * Whether `run` takes a message now, as the live run on a session that steers
 * and a harness turn still running: one that ended is only saving its files
 * (`RunnerTurnDrive.ts`), so a steer then would never reach the agent. A
 * message for another model needs a turn of its own.
 */
export function canSteer(projection: Projection, run: Run, modelSelection?: ModelSelection) {
  if (activeRun(projection)?.id !== run.id || run.status !== "running") return false;
  if (
    modelSelection !== undefined &&
    (modelSelection.instanceId !== run.modelSelection.instanceId ||
      modelSelection.model !== run.modelSelection.model)
  ) {
    return false;
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  );
  return (
    session?.capabilities.turns.supportsActiveSteering === true &&
    runningProviderTurn(projection, run) !== undefined
  );
}

/**
 * The run `command` steers, or none to queue it. As upstream resolves it: an
 * explicit steer, or `auto` on a session that steers. Anything that can't
 * steer queues instead, so nothing the person sends is ever dropped. A
 * notification an agent sends waits for the turn, as upstream's do.
 */
export function steerTarget(projection: Projection, command: Dispatch): Run | undefined {
  const live = activeRun(projection);
  if (live === undefined || command.notification !== undefined) return undefined;
  const wanted =
    command.dispatchMode.type === "steer_active"
      ? command.dispatchMode.targetRunId === live.id
      : command.dispatchMode.type === "start_immediately" &&
        (command.deliveryIntent === "steer" || command.deliveryIntent === "auto");
  return wanted && canSteer(projection, live, command.modelSelection) ? live : undefined;
}

/** `message` joins `run` as a steer: its own row in the run's transcript, after what it shows. */
export function steerEvents(
  projection: Projection,
  run: Run,
  message: OrchestrationV2ConversationMessage,
  inputIntent: "steer" | "promoted_queued_to_steer",
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const steered = { ...message, runId: run.id, nodeId: run.rootNodeId, updatedAt: ctx.now };
  const item: OrchestrationV2TurnItem = {
    id: ids.steerItem(run.id, message.id),
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: runningProviderTurn(projection, run)?.id ?? null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: ctx.now,
    completedAt: ctx.now,
    updatedAt: ctx.now,
    type: "user_message",
    createdBy: message.createdBy,
    creationSource: message.creationSource,
    messageId: message.id,
    inputIntent,
    text: message.text,
    attachments: message.attachments,
    ...(message.context === undefined ? {} : { context: message.context }),
  };
  return [messageEvent(ctx, steered), turnItemEvent(ctx, positionTurnItem(projection, item))];
}

/**
 * The messages steered into `run`, in the order they joined it: their rows'
 * order, which only grows. A promoted message keeps when it was first sent.
 */
export function steersOf(projection: Projection, run: Run) {
  const rows = projection.turnItems
    .filter(
      (item) =>
        item.runId === run.id &&
        item.type === "user_message" &&
        (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  return rows.flatMap((row) => {
    const message =
      row.type === "user_message"
        ? projection.messages.find((candidate) => candidate.id === row.messageId)
        : undefined;
    return message === undefined ? [] : [message];
  });
}

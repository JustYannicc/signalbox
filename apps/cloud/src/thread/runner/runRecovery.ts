import {
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  TurnItemId,
} from "@t3tools/contracts";

import { finishRunEvents, isLiveRun, startRunEvents } from "../runLifecycle.ts";
import { type DecisionContext, ids, messageEvent, turnItemEvent } from "../threadEvents.ts";
import { applyEvents } from "../threadProjection.ts";
import { systemNoticeEvents } from "./runnerEvents.ts";
import { failRunEvents, unknownFailure } from "./runnerTurn.ts";

/**
 * What a thread does when the machine running its turn is lost (#112, #132):
 * the cut run ends interrupted, with whatever was still streaming or running
 * shown as aborted, and a continuation run picks the work up on a new
 * machine. That machine restores the harness's session at its latest durable
 * row and the worktree at its latest auto-save, then resumes natively, so the
 * model redoes only what never became durable. A tool that was running is
 * reported as interrupted and never run again by the thread; the harness
 * sees it unfinished in its own session.
 *
 * The continuation follows upstream's restart continuation: a new run with
 * `restartContinuationOfRunId`, prompted "Continue where you left off." where
 * the harness needs a prompt to go on. Pure, like the decider.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

export const CONTINUE_PROMPT = "Continue where you left off.";

/** Machines lost in a row before the thread stops trying and fails the run. */
export const MAX_CONTINUATIONS = 3;

const LOST_MACHINE = "Lost the machine running this turn.";

/** How many continuations led to `run`, following `restartContinuationOfRunId` back. */
const continuationDepth = (projection: Projection, run: Run) => {
  let depth = 0;
  let current: Run | undefined = run;
  while (current?.restartContinuationOfRunId !== undefined && depth <= MAX_CONTINUATIONS) {
    depth += 1;
    const previous: RunId = current.restartContinuationOfRunId;
    current = projection.runs.find((candidate) => candidate.id === previous);
  }
  return depth;
};

/** The run's rows still streaming or running, settled as interrupted. */
function abortedEvents(
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const live = new Set<OrchestrationV2TurnItem["status"]>(["pending", "running", "waiting"]);
  const items = projection.turnItems
    .filter((item) => item.runId === run.id && live.has(item.status))
    .map(
      (item) =>
        ({
          ...item,
          status: "interrupted",
          completedAt: ctx.now,
          updatedAt: ctx.now,
          ...("streaming" in item ? { streaming: false } : {}),
        }) as OrchestrationV2TurnItem,
    );
  const messages = projection.messages.filter(
    (message) => message.runId === run.id && message.streaming,
  );
  return [
    ...items.map((item) => turnItemEvent(ctx, item)),
    ...messages.map((message) =>
      messageEvent(ctx, { ...message, streaming: false, updatedAt: ctx.now }),
    ),
  ];
}

/**
 * Ends the live `run` whose machine was lost, and starts its continuation. A
 * run the harness never started fails instead, since its session never saw
 * the request; so does one after too many lost machines in a row.
 */
export function recoverRunEvents(
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  if (!isLiveRun(run)) return [];
  const aborted = abortedEvents(projection, run, ctx);
  if (run.startedAt === null || continuationDepth(projection, run) >= MAX_CONTINUATIONS) {
    const settled = applyEvents(projection, aborted) ?? projection;
    return [...aborted, ...failRunEvents(settled, run, unknownFailure(LOST_MACHINE), ctx)];
  }
  const threadId = projection.thread.id;
  const ended = finishRunEvents(projection, run, "interrupted", ctx, {
    queue: "keep",
    leading: [
      ...aborted,
      ...systemNoticeEvents(
        projection,
        run,
        {
          id: TurnItemId.make(`turn-item:${run.id}:machine-lost`),
          title: "Machine",
          message: "The machine running this turn went away. It picks up on a new one.",
        },
        ctx,
      ),
    ],
  });
  const afterEnd = applyEvents(projection, ended) ?? projection;
  const ordinal = afterEnd.runs.length + 1;
  const continuation: Run = {
    id: ids.run(threadId, ordinal),
    threadId,
    ordinal,
    providerInstanceId: run.providerInstanceId,
    modelSelection: run.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:restart-continuation:${run.id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "starting",
    queuePosition: null,
    requestedAt: ctx.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    restartContinuationOfRunId: run.id,
    workStartedAt: run.workStartedAt ?? run.startedAt ?? run.requestedAt,
  };
  const message = messageEvent(ctx, {
    createdBy: "agent",
    creationSource: "server",
    id: continuation.userMessageId,
    threadId,
    runId: continuation.id,
    nodeId: null,
    role: "user",
    text: CONTINUE_PROMPT,
    attachments: [],
    streaming: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  const withMessage = applyEvents(afterEnd, [message]) ?? afterEnd;
  return [...ended, message, ...startRunEvents(withMessage, continuation, "turn_start", ctx)];
}

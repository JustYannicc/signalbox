import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunAttemptId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

import {
  attemptEvent,
  type DecisionContext,
  itemOrdinal,
  nodeEvent,
  providerThreadEvent,
  runEvent,
  turnItemEvent,
} from "./threadEvents.ts";

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;
type RetryCommand = Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>;

const PREPARATION_INPUT = "Preparing workspace";
const PREPARATION_FAILURE_CODE = ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE;
const PREPARATION_FAILURE_POSITION = 900_000;

export type PreparationCommandDecision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }
  | { readonly _tag: "rejected"; readonly message: string };

const accept = (events: ReadonlyArray<OrchestrationV2DomainEvent>): PreparationCommandDecision => ({
  _tag: "accepted",
  events,
});

const reject = (message: string): PreparationCommandDecision => ({
  _tag: "rejected",
  message,
});

const isBlockingRun = (run: Run) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

/** Records a machine setup failure as a retryable workspace preparation. */
export function failedPreparationEvents(
  projection: Projection,
  runId: Run["id"],
  message: string,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (
    run === undefined ||
    (run.status !== "preparing" && run.status !== "starting") ||
    run.startedAt !== null ||
    run.workStartedAt !== undefined
  ) {
    return null;
  }
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    attempt === undefined ||
    attempt.status !== "pending" ||
    attempt.startedAt !== null ||
    rootNode === undefined ||
    rootNode.status !== "pending" ||
    rootNode.startedAt !== null ||
    providerThread === undefined ||
    !projection.messages.some((candidate) => candidate.id === run.userMessageId)
  ) {
    return null;
  }

  const failure: OrchestrationV2ProviderFailure = {
    class: "validation_error",
    message,
    code: PREPARATION_FAILURE_CODE,
    retryable: false,
  };
  const preparationItem = projection.turnItems.find(
    (
      candidate,
    ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
      candidate.runId === run.id &&
      candidate.type === "command_execution" &&
      candidate.input === PREPARATION_INPUT,
  );
  const common = {
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: rootNode.id,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "failed" as const,
    title: "Workspace preparation failed",
    startedAt: ctx.now,
    completedAt: ctx.now,
    updatedAt: ctx.now,
  };
  const failureItem = {
    ...common,
    id: TurnItemId.make(`turn-item:${run.id}:preparation-failure:${attempt.attemptOrdinal}`),
    ordinal: itemOrdinal(run.ordinal, PREPARATION_FAILURE_POSITION + attempt.attemptOrdinal),
    type: "error" as const,
    failure,
  } satisfies OrchestrationV2TurnItem;

  const latestExecuted = latestExecutedRun(projection.runs);
  return [
    attemptEvent(ctx, run.threadId, "run-attempt.updated", {
      ...attempt,
      status: "failed",
      completedAt: ctx.now,
    }),
    nodeEvent(ctx, { ...rootNode, status: "failed", completedAt: ctx.now }),
    ...(preparationItem === undefined
      ? [
          turnItemEvent(ctx, {
            ...common,
            id: TurnItemId.make(`turn-item:${run.id}:preparation`),
            ordinal: itemOrdinal(run.ordinal, 1),
            type: "command_execution",
            input: PREPARATION_INPUT,
            output: message,
            exitCode: 1,
          }),
        ]
      : [
          turnItemEvent(ctx, {
            ...preparationItem,
            ...common,
            output: message,
            exitCode: 1,
          }),
        ]),
    turnItemEvent(ctx, failureItem),
    runEvent(ctx, "run.updated", {
      ...run,
      workspacePreparation: run.workspacePreparation ?? { type: "root" },
      status: "failed",
      completedAt: ctx.now,
    }),
    providerThreadEvent(ctx, run.threadId, {
      ...providerThread,
      status: "idle",
      updatedAt: ctx.now,
    }),
    ...(latestExecuted?.id !== run.id
      ? []
      : projection.runs
          .filter((candidate) => candidate.status === "queued" && candidate.queueHeld !== true)
          .map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: true }))),
  ];
}

/** Clears the retried preparation and hands it back to the provider after the Runner connects. */
export function readyPreparationEvents(
  projection: Projection,
  runId: Run["id"],
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run?.status !== "preparing") return [];
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const preparationItem = projection.turnItems.find(
    (
      candidate,
    ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
      candidate.runId === run.id &&
      candidate.type === "command_execution" &&
      candidate.input === PREPARATION_INPUT &&
      candidate.status === "running",
  );
  if (
    attempt?.status !== "pending" ||
    attempt.startedAt !== null ||
    rootNode?.status !== "pending" ||
    rootNode.startedAt !== null ||
    preparationItem === undefined
  ) {
    return [];
  }
  return [
    turnItemEvent(ctx, {
      ...preparationItem,
      status: "completed",
      title: "Workspace ready",
      output: "Workspace preparation completed.",
      exitCode: 0,
      completedAt: ctx.now,
      updatedAt: ctx.now,
    }),
    runEvent(ctx, "run.updated", { ...run, status: "starting" }),
  ];
}

const withoutPreparationResult = (
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) => {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
};

function retryPreparation(
  projection: Projection,
  command: RetryCommand,
  ctx: DecisionContext,
): PreparationCommandDecision {
  const run = projection.runs.find((candidate) => candidate.id === command.runId);
  const failureMessage = `Run ${command.runId} has no failed workspace preparation to retry.`;
  if (
    run === undefined ||
    run.status !== "failed" ||
    run.workspacePreparation === undefined ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null
  ) {
    return reject(failureMessage);
  }
  if (projection.runs.some((candidate) => candidate.id !== run.id && isBlockingRun(candidate))) {
    return reject("Another run is active on this thread.");
  }

  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const preparationItem = projection.turnItems.find(
    (
      candidate,
    ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
      candidate.runId === run.id &&
      candidate.type === "command_execution" &&
      candidate.input === PREPARATION_INPUT &&
      candidate.status === "failed",
  );
  const failureItem = projection.turnItems.find(
    (candidate): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "error" }> =>
      candidate.runId === run.id &&
      candidate.type === "error" &&
      candidate.status === "failed" &&
      candidate.failure.code === PREPARATION_FAILURE_CODE,
  );
  const userMessage = projection.messages.find(
    (candidate) => candidate.id === run.userMessageId && candidate.role === "user",
  );
  if (
    attempt === undefined ||
    attempt.status !== "failed" ||
    attempt.runId !== run.id ||
    attempt.rootNodeId !== rootNode?.id ||
    attempt.providerThreadId !== providerThread?.id ||
    attempt.startedAt !== null ||
    attempt.providerTurnId !== null ||
    rootNode === undefined ||
    rootNode.runId !== run.id ||
    rootNode.status !== "failed" ||
    rootNode.startedAt !== null ||
    rootNode.providerTurnId !== null ||
    providerThread === undefined ||
    preparationItem === undefined ||
    preparationItem.nodeId !== rootNode.id ||
    failureItem === undefined ||
    failureItem.nodeId !== rootNode.id ||
    userMessage === undefined ||
    run.startedAt !== null ||
    run.workStartedAt !== undefined
  ) {
    return reject(failureMessage);
  }

  const attemptOrdinal =
    Math.max(
      0,
      ...projection.attempts
        .filter((candidate) => candidate.runId === run.id)
        .map((candidate) => candidate.attemptOrdinal),
    ) + 1;
  const nextAttemptId = RunAttemptId.make(`attempt:${run.id}:${attemptOrdinal}`);
  const nextAttempt: OrchestrationV2RunAttempt = {
    ...attempt,
    id: nextAttemptId,
    attemptOrdinal,
    reason: "retry",
    status: "pending",
    providerTurnId: null,
    startedAt: null,
    completedAt: null,
  };
  const updatedAt = ctx.now;
  const failureOwnsQueue = latestExecutedRun(projection.runs)?.id === run.id;

  return accept([
    turnItemEvent(ctx, { ...failureItem, status: "cancelled", updatedAt }),
    turnItemEvent(ctx, {
      ...withoutPreparationResult(preparationItem),
      status: "running",
      title: PREPARATION_INPUT,
      completedAt: null,
      updatedAt,
    }),
    attemptEvent(ctx, run.threadId, "run-attempt.created", nextAttempt),
    nodeEvent(ctx, {
      ...rootNode,
      status: "pending",
      providerTurnId: null,
      startedAt: null,
      completedAt: null,
    }),
    runEvent(ctx, "run.updated", {
      ...run,
      activeAttemptId: nextAttemptId,
      status: "preparing",
      startedAt: null,
      completedAt: null,
    }),
    ...(!failureOwnsQueue
      ? []
      : projection.runs
          .filter((candidate) => candidate.status === "queued" && candidate.queueHeld === true)
          .map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: false }))),
  ]);
}

/** Handles preparation retry only; the thread decider owns all other command types. */
export function decidePreparationCommand(
  projection: Projection,
  command: OrchestrationV2Command,
  ctx: DecisionContext,
): PreparationCommandDecision | undefined {
  return command.type === "prepared-run.retry"
    ? retryPreparation(projection, command, ctx)
    : undefined;
}

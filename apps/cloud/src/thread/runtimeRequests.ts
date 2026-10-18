import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ThreadMessage } from "@signalbox/runner-protocol/RunnerProtocol";
import { isRunAttemptOrContinuation } from "@signalbox/runner-protocol/RunAttemptIdentity";

import { isLiveRun } from "./runState.ts";
import {
  type Decision,
  type DecisionContext,
  nodeEvent,
  runEvent,
  turnItemEvent,
  unstampedEventId,
} from "./threadEvents.ts";

type Projection = OrchestrationV2ThreadProjection;
type Request = OrchestrationV2RuntimeRequest;
type ResponseCommand = Extract<
  OrchestrationV2Command,
  {
    readonly type: "runtime-request.respond" | "thread.user-input.dismiss";
  }
>;

/** The request's current attempt and native callback destination, never a newer run's. */
export function runtimeRequestContext(projection: Projection, request: Request) {
  const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
  const run = projection.runs.find((candidate) => candidate.id === node?.runId);
  const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
  if (
    node === undefined ||
    run === undefined ||
    (!isLiveRun(run) &&
      !(request.responseCapability.type === "message" && run.status === "completed")) ||
    attempt === undefined ||
    node.rootNodeId !== attempt.rootNodeId ||
    attempt.runId !== run.id
  )
    return null;
  if (request.responseCapability.type !== "live") return { node, run, attempt, session: null };
  const capability = request.responseCapability;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === capability.providerSessionId,
  );
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === node.providerThreadId,
  );
  const turn = projection.providerTurns.find(
    (candidate) => candidate.id === request.providerTurnId,
  );
  if (
    session === undefined ||
    providerThread?.providerSessionId !== session.id ||
    (request.providerTurnId !== null &&
      (turn === undefined ||
        turn.runAttemptId === null ||
        !isRunAttemptOrContinuation(attempt.id, turn.runAttemptId) ||
        turn.providerThreadId !== providerThread.id))
  )
    return null;
  return { node, run, attempt, session };
}

const requestEvent = (
  projection: Projection,
  request: Request,
  ctx: DecisionContext,
): OrchestrationV2DomainEvent => ({
  id: unstampedEventId,
  type: "runtime-request.updated",
  threadId: projection.thread.id,
  nodeId: request.nodeId,
  occurredAt: ctx.now,
  payload: request,
});

const hasPendingSecret = (projection: Projection, runId: string) =>
  projection.turnItems.some(
    (item) =>
      item.type === "secret_request" && item.runId === runId && item.secretStatus === "pending",
  );

/** Committed decisions are the answer outbox; reconnects replay only the matching live attempt. */
export function runtimeResponses(
  projection: Projection,
  runId: string,
): ReadonlyArray<Extract<ThreadMessage, { type: "runtime-request.respond" }>> {
  const runNodes = new Set(
    projection.nodes.filter((node) => node.runId === runId).map((node) => node.id),
  );
  return projection.runtimeRequests.flatMap((request) => {
    if (
      request.status !== "resolved" ||
      request.responseCapability.type !== "live" ||
      !runNodes.has(request.nodeId)
    )
      return [];
    const context = runtimeRequestContext(projection, request);
    if (context === null || context.session === null) return [];
    return [
      {
        type: "runtime-request.respond" as const,
        requestId: request.id,
        runId: context.run.id,
        attemptId: context.attempt.id,
        providerSessionId: context.session.id,
        ...(request.decision === undefined ? {} : { decision: request.decision }),
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      },
    ];
  });
}

/** Resolves request, node and visible card in the same command commit. */
export function respondToRuntimeRequest(
  projection: Projection,
  command: ResponseCommand,
  ctx: DecisionContext,
): Decision {
  const reject = (message: string): Decision => ({ _tag: "rejected", message });
  const request = projection.runtimeRequests.find(
    (candidate) => candidate.id === command.requestId,
  );
  if (request === undefined) return reject("This request was not found.");
  if (request.status !== "pending")
    return reject("This request has already been answered or ended.");
  if (request.responseCapability.type === "not_resumable")
    return reject(request.responseCapability.reason);
  const context = runtimeRequestContext(projection, request);
  if (context === null) return reject("This request's turn has ended or been replaced.");
  const dismiss = command.type === "thread.user-input.dismiss";
  if (dismiss && request.kind !== "user_input") return reject("Only a question can be dismissed.");
  const decision = dismiss ? "cancel" : command.decision;
  const cancelled = decision === "decline" || decision === "cancel";
  const suppliedAnswers = command.type === "runtime-request.respond" ? command.answers : undefined;
  const answers =
    request.kind === "user_input" && cancelled && request.responseCapability.type === "live"
      ? (suppliedAnswers ?? {})
      : suppliedAnswers;
  const item = projection.turnItems.find(
    (candidate) =>
      (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
      candidate.requestId === request.id,
  );
  if (request.kind === "user_input" && !cancelled) {
    if (item?.type !== "user_input_request")
      return reject("The question for this request was not found.");
    if (
      item.questions.some((question) => {
        const answer = answers?.[question.id];
        return (
          question.required !== false && (typeof answer !== "string" || answer.trim().length === 0)
        );
      })
    )
      return reject("Answer each question before sending.");
    if (
      !Object.values(answers ?? {}).some(
        (answer) => typeof answer === "string" && answer.trim().length > 0,
      )
    )
      return reject("Enter an answer before sending.");
  } else if (request.kind !== "user_input" && decision === undefined) {
    return reject("Choose whether to approve this request.");
  }
  const status = cancelled ? ("cancelled" as const) : ("completed" as const);
  const resolved: Request = {
    ...request,
    status: "resolved",
    resolvedAt: ctx.now,
    ...(decision === undefined ? {} : { decision }),
    ...(answers === undefined ? {} : { answers }),
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    requestEvent(projection, resolved, ctx),
    nodeEvent(ctx, { ...context.node, status, completedAt: ctx.now }),
  ];
  if (item !== undefined)
    events.push(
      turnItemEvent(ctx, {
        ...item,
        status,
        completedAt: ctx.now,
        updatedAt: ctx.now,
        ...(item.type === "user_input_request" && answers !== undefined
          ? {
              questionAnswer: {
                requestId: request.id,
                answers,
                attachmentsByQuestionId:
                  command.type === "runtime-request.respond"
                    ? (command.attachmentsByQuestionId ?? {})
                    : {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            }
          : {}),
      }),
    );
  const otherPending = projection.runtimeRequests.some(
    (candidate) =>
      candidate.id !== request.id &&
      candidate.status === "pending" &&
      runtimeRequestContext(projection, candidate)?.run.id === context.run.id,
  );
  if (
    !otherPending &&
    !hasPendingSecret(projection, context.run.id) &&
    context.run.status === "waiting"
  )
    events.push(runEvent(ctx, "run.updated", { ...context.run, status: "running" }));
  return { _tag: "accepted", events };
}

/** Provider resends cannot reopen a request answered by a committed user command. */
export function runtimeRequestEvents(
  projection: Projection,
  event: Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>,
  ctx: DecisionContext,
) {
  const existing = projection.runtimeRequests.find(
    (candidate) => candidate.id === event.payload.id,
  );
  if (existing !== undefined && existing.status !== "pending") return [];
  const request = event.payload;
  const context = runtimeRequestContext(projection, request);
  if (context === null) return [];
  const otherPending = projection.runtimeRequests.some(
    (candidate) =>
      candidate.id !== request.id &&
      candidate.status === "pending" &&
      runtimeRequestContext(projection, candidate)?.run.id === context.run.id,
  );
  return [
    event,
    ...(request.status === "pending" &&
    request.responseCapability.type === "live" &&
    context.run.status === "running"
      ? [runEvent(ctx, "run.updated", { ...context.run, status: "waiting" })]
      : request.status !== "pending" &&
          !otherPending &&
          !hasPendingSecret(projection, context.run.id) &&
          context.run.status === "waiting"
        ? [runEvent(ctx, "run.updated", { ...context.run, status: "running" })]
        : []),
  ];
}

/** Ending a run also ends its callbacks, so late runner events cannot leave stale needs-you. */
export function expireRuntimeRequests(
  projection: Projection,
  runId: string,
  ctx: DecisionContext,
  completed = false,
) {
  return projection.runtimeRequests
    .filter(
      (request) =>
        request.status === "pending" &&
        !(completed && request.responseCapability.type === "message") &&
        projection.nodes.some((node) => node.id === request.nodeId && node.runId === runId),
    )
    .flatMap((request): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const node = projection.nodes.find((node) => node.id === request.nodeId);
      const item = projection.turnItems.find(
        (item) =>
          (item.type === "approval_request" || item.type === "user_input_request") &&
          item.requestId === request.id,
      );
      return [
        requestEvent(
          projection,
          {
            ...request,
            status: "expired",
            resolvedAt: ctx.now,
            responseCapability: { type: "not_resumable", reason: "The turn ended." },
          },
          ctx,
        ),
        ...(node === undefined
          ? []
          : [nodeEvent(ctx, { ...node, status: "cancelled", completedAt: ctx.now })]),
        ...(item === undefined
          ? []
          : [
              turnItemEvent(ctx, {
                ...item,
                status: "cancelled",
                completedAt: ctx.now,
                updatedAt: ctx.now,
              }),
            ]),
      ];
    });
}

/** Older cloud builds ended runs without retiring their native callbacks. Repair through events. */
export function expireEndedRuntimeRequests(projection: Projection, ctx: DecisionContext) {
  return projection.runs
    .filter((run) => !isLiveRun(run) && run.status !== "queued")
    .flatMap((run) => expireRuntimeRequests(projection, run.id, ctx, run.status === "completed"));
}

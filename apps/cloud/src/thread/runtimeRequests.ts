import {
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type { ThreadMessage } from "@signalbox/runner-protocol/RunnerProtocol";
import { isRunAttemptOrContinuation } from "@signalbox/runner-protocol/RunAttemptIdentity";

import { isSecretSendId } from "./secretSendIdentity.ts";
import { isLiveRun } from "./runState.ts";
import * as Schema from "effect/Schema";
import {
  type Decision,
  type DecisionContext,
  nodeEvent,
  runtimeRequestEvent,
  runEvent,
  turnItemEvent,
  unstampedEventId,
} from "./threadEvents.ts";
import { positionTurnItem } from "./turnItemPosition.ts";

const isJson = Schema.is(Schema.Json);
const hasAnswer = (answer: unknown) =>
  typeof answer === "string" ? answer.trim().length > 0 : answer !== null && isJson(answer);

type Projection = OrchestrationV2ThreadProjection;
type Request = OrchestrationV2RuntimeRequest;
type Run = OrchestrationV2Run;

/** The deterministic approval row created by the cloud egress gate. */
export const requestItemId = (requestId: RuntimeRequestId) =>
  TurnItemId.make(`turn-item:${requestId}`);

/** Cloud egress approvals use the root and their own card ID; native requests use allocator IDs. */
export function isCloudApprovalRequest(projection: Projection, request: Request): boolean {
  if (
    request.kind !== "permission" ||
    request.providerTurnId !== null ||
    request.nativeRequestRef !== null
  )
    return false;
  const run = projection.runs.find((candidate) => candidate.rootNodeId === request.nodeId);
  if (run === undefined) return false;
  return projection.turnItems.some(
    (item) =>
      item.id === requestItemId(request.id) &&
      item.type === "approval_request" &&
      item.requestId === request.id &&
      item.nodeId === run.rootNodeId &&
      item.runId === run.id,
  );
}

/** An approval the cloud asks the person on `run`, or null when it can't. */
export function approvalRequestEvents(
  projection: Projection,
  run: Run,
  approval: {
    readonly requestId: RuntimeRequestId;
    readonly title: string;
    readonly prompt: string;
    readonly appName: string;
    readonly options: ReadonlyArray<ProviderApprovalOption>;
  },
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | null {
  const session = projection.providerSessions.at(-1);
  if (run.rootNodeId === null || session === undefined) return null;
  const request: Request = {
    id: approval.requestId,
    nodeId: run.rootNodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "permission",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: session.id },
    createdAt: ctx.now,
    resolvedAt: null,
  };
  const item: OrchestrationV2TurnItem = {
    id: requestItemId(approval.requestId),
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting",
    title: approval.title,
    startedAt: ctx.now,
    completedAt: null,
    updatedAt: ctx.now,
    type: "approval_request",
    requestId: approval.requestId,
    requestKind: "permission",
    prompt: approval.prompt,
    appName: approval.appName,
    options: approval.options,
  };
  return [
    runtimeRequestEvent(ctx, projection.thread.id, run.id, request),
    turnItemEvent(ctx, positionTurnItem(projection, item)),
  ];
}

const runOf = (projection: Projection, request: Request) =>
  projection.runs.find((run) => run.rootNodeId === request.nodeId);

const settledEvents = (
  projection: Projection,
  request: Request,
  settled:
    | { readonly status: "resolved"; readonly decision: ProviderApprovalDecision }
    | { readonly status: "expired" },
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const run = runOf(projection, request);
  if (run === undefined) return [];
  const item = projection.turnItems.find((candidate) => candidate.id === requestItemId(request.id));
  const declined =
    settled.status === "expired" || settled.decision === "decline" || settled.decision === "cancel";
  return [
    runtimeRequestEvent(ctx, projection.thread.id, run.id, {
      ...request,
      status: settled.status,
      resolvedAt: ctx.now,
      ...(settled.status === "resolved" ? { decision: settled.decision } : {}),
    }),
    ...(item === undefined
      ? []
      : [
          turnItemEvent(ctx, {
            ...item,
            status: declined ? "cancelled" : "completed",
            completedAt: ctx.now,
            updatedAt: ctx.now,
          }),
        ]),
  ];
};

/** A decision for a cloud-owned approval; native provider callbacks use respondToRuntimeRequest. */
export function answerRequestEvents(
  projection: Projection,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision | undefined,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | string {
  const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId);
  if (!request || !isCloudApprovalRequest(projection, request) || request.status !== "pending")
    return "That request isn't waiting for an answer anymore.";
  if (decision === undefined) return "Answer it with one of its choices.";
  const item = projection.turnItems.find((candidate) => candidate.id === requestItemId(requestId));
  const options = item?.type === "approval_request" ? item.options : undefined;
  if (options !== undefined && !options.some((option) => option.decision === decision)) {
    return "That isn't one of this request's choices.";
  }
  const events = settledEvents(projection, request, { status: "resolved", decision }, ctx);
  const run = runOf(projection, request);
  if (run === undefined || run.status !== "waiting") return events;
  const otherPending = projection.runtimeRequests.some(
    (candidate) =>
      candidate.id !== request.id &&
      candidate.status === "pending" &&
      runtimeRequestContext(projection, candidate)?.run.id === run.id,
  );
  return !otherPending && !hasPendingSecret(projection, run.id)
    ? [...events, runEvent(ctx, "run.updated", { ...run, status: "running" })]
    : events;
}

/** Expires a cloud approval without changing the root node's native callback state. */
export function expireRequestEvents(
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  return projection.runtimeRequests
    .filter(
      (request) =>
        request.status === "pending" &&
        request.nodeId === run.rootNodeId &&
        isCloudApprovalRequest(projection, request),
    )
    .flatMap((request) => settledEvents(projection, request, { status: "expired" }, ctx));
}

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
      isCloudApprovalRequest(projection, request) ||
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
  if (isCloudApprovalRequest(projection, request))
    return reject("This request is answered by the thread.");
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
        return question.required !== false && !hasAnswer(answer);
      })
    )
      return reject("Answer each question before sending.");
    if (!Object.values(answers ?? {}).some(hasAnswer))
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
  if (isSecretSendId(event.payload.id)) return [];
  const existing = projection.runtimeRequests.find(
    (candidate) => candidate.id === event.payload.id,
  );
  if (
    existing !== undefined &&
    (existing.status !== "pending" || isCloudApprovalRequest(projection, existing))
  )
    return [];
  const request = event.payload;
  if (isCloudApprovalRequest(projection, request)) return [];
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
      if (isCloudApprovalRequest(projection, request)) {
        return settledEvents(projection, request, { status: "expired" }, ctx);
      }
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

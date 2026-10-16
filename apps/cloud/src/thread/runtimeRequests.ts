import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";

import { positionTurnItem } from "./runner/runnerEvents.ts";
import { type DecisionContext, runtimeRequestEvent, turnItemEvent } from "./threadEvents.ts";

/**
 * A cloud thread waiting on its person (#410): an approval the thread itself
 * raises, as upstream's are, so every client shows it the way it shows a
 * harness's approval, and the sidebar and phone show the thread waiting. The
 * request sits on its run's root node; its `approval_request` row says what
 * is asked and which answers there are.
 *
 * Only the thread object raises these so far (the egress check, #592): a cloud
 * machine's harness can't ask yet. Answering one is `runtime-request.respond`;
 * a run that ends lets its unanswered ones go.
 */

type Projection = OrchestrationV2ThreadProjection;

/** The `approval_request` row of `requestId`. */
export const requestItemId = (requestId: RuntimeRequestId) =>
  TurnItemId.make(`turn-item:${requestId}`);

/** The run a request sits on: the one whose root node it names. */
const runOf = (projection: Projection, request: OrchestrationV2RuntimeRequest) =>
  projection.runs.find((run) => run.rootNodeId === request.nodeId);

/**
 * An approval the person answers on `run`, or null when the run can't wait on
 * one: it has no root node yet, or no harness session the answer belongs to.
 */
export function approvalRequestEvents(
  projection: Projection,
  run: OrchestrationV2Run,
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
  const request: OrchestrationV2RuntimeRequest = {
    id: approval.requestId,
    nodeId: run.rootNodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "permission",
    status: "pending",
    // Answered on the thread itself, which is always there to hear it.
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

/** Settles `request` and its row: answered with `decision`, or let go unanswered. */
function settledEvents(
  projection: Projection,
  request: OrchestrationV2RuntimeRequest,
  settled:
    | { readonly status: "resolved"; readonly decision: ProviderApprovalDecision }
    | { readonly status: "expired" },
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
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
}

/** The person's answer to a pending request; an error message when it can't be answered. */
export function answerRequestEvents(
  projection: Projection,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision | undefined,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | string {
  const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId);
  if (request === undefined || request.status !== "pending") {
    return "That request isn't waiting for an answer anymore.";
  }
  if (decision === undefined) return "Answer it with one of its choices.";
  const item = projection.turnItems.find((candidate) => candidate.id === requestItemId(requestId));
  const options = item?.type === "approval_request" ? item.options : undefined;
  if (options !== undefined && !options.some((option) => option.decision === decision)) {
    return "That isn't one of this request's choices.";
  }
  return settledEvents(projection, request, { status: "resolved", decision }, ctx);
}

/** Lets go of `run`'s unanswered requests: it ended, so nothing waits on them now. */
export function expireRequestEvents(
  projection: Projection,
  run: OrchestrationV2Run,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  return projection.runtimeRequests
    .filter((request) => request.status === "pending" && request.nodeId === run.rootNodeId)
    .flatMap((request) => settledEvents(projection, request, { status: "expired" }, ctx));
}

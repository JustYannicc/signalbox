import type { SignalboxAskAnswerer } from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand } from "@t3tools/shared/signalboxAsks";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import type { Decision } from "./threadEvents.ts";
import { activeRun } from "./runLifecycle.ts";
import { type DecisionContext, threadEvent, unstampedEventId } from "./threadEvents.ts";

type Response = Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>;
type Message = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
const isJson = Schema.is(Schema.Json);

export function canAnswerLiveRequest(
  projection: OrchestrationV2ThreadProjection,
  request: OrchestrationV2RuntimeRequest,
) {
  if (request.status !== "pending" || request.responseCapability.type !== "live") return false;
  const capability = request.responseCapability;
  const session = projection.providerSessions.find(
    (entry) => entry.id === capability.providerSessionId,
  );
  const live = activeRun(projection);
  const turn = projection.providerTurns.find((entry) => entry.id === request.providerTurnId);
  const node = projection.nodes.find((entry) => entry.id === request.nodeId);
  const item = projection.turnItems.find(
    (entry) => "requestId" in entry && entry.requestId === request.id,
  );
  return (
    session !== undefined &&
    session.status !== "stopped" &&
    session.status !== "error" &&
    live !== undefined &&
    live.id === (item?.runId ?? node?.runId) &&
    turn?.runAttemptId === live.activeAttemptId &&
    turn.status === "running"
  );
}

export function runtimeResponseEvents(
  projection: OrchestrationV2ThreadProjection,
  command: Response,
  ctx: DecisionContext,
  deliver: (
    projection: OrchestrationV2ThreadProjection,
    command: Message,
    ctx: DecisionContext,
  ) => Decision,
  answerer: SignalboxAskAnswerer = { kind: "person", personId: "thread-owner" },
): Decision {
  const reject = (message: string): Decision => ({ _tag: "rejected", message });
  const request = projection.runtimeRequests.find((entry) => entry.id === command.requestId);
  if (request?.status !== "pending") return reject("That runtime request is no longer pending.");
  if (request.responseCapability.type === "not_resumable")
    return reject(request.responseCapability.reason);
  if (
    command.attachmentsByQuestionId &&
    Object.values(command.attachmentsByQuestionId).some((files) => files.length)
  )
    return reject("Cloud questions do not accept attachments yet.");
  const item = projection.turnItems.find(
    (entry) => "requestId" in entry && entry.requestId === request.id,
  );
  const node = projection.nodes.find((entry) => entry.id === request.nodeId);
  const runId = item?.runId ?? node?.runId;
  if (request.kind === "user_input") {
    if (item?.type !== "user_input_request")
      return reject("The questions for this request were not found.");
    if (item.questions.some((question) => question.native?.isSecret === true))
      return reject("Use a secret request or URL elicitation for secrets.");
    if (command.answers === undefined || command.decision !== undefined)
      return reject("Answer the questions in this request.");
    if (
      Object.keys(command.answers).some(
        (key) => !item.questions.some((question) => question.id === key),
      )
    )
      return reject("This response contains an unknown question.");
    if (
      item.questions.some(
        (question) => question.required !== false && command.answers?.[question.id] === undefined,
      )
    )
      return reject("Answer each required question before sending.");
  } else if (command.decision === undefined || command.answers !== undefined) {
    return reject("Choose an approval decision for this request.");
  }
  if (request.responseCapability.type === "live" && !canAnswerLiveRequest(projection, request))
    return reject("That provider session ended. Answer its durable ask instead.");
  const base = {
    id: unstampedEventId,
    threadId: projection.thread.id,
    occurredAt: ctx.now,
    ...(runId == null ? {} : { runId }),
    nodeId: request.nodeId,
    providerInstanceId: projection.thread.providerInstanceId,
  };
  const status =
    command.decision === "decline" || command.decision === "cancel"
      ? ("cancelled" as const)
      : ("completed" as const);
  const events: OrchestrationV2DomainEvent[] = [
    {
      ...base,
      type: "runtime-request.updated",
      payload: {
        ...request,
        status: "resolved",
        resolvedAt: ctx.now,
        ...(command.answers === undefined ? {} : { answers: command.answers }),
        ...(command.decision === undefined ? {} : { decision: command.decision }),
      },
    },
  ];
  if (node)
    events.push({
      ...base,
      type: "node.updated",
      payload: { ...node, status, completedAt: ctx.now },
    });
  if (item)
    events.push({
      ...base,
      type: "turn-item.updated",
      payload: {
        ...item,
        status,
        completedAt: ctx.now,
        updatedAt: ctx.now,
        ...(item.type === "user_input_request" && command.answers !== undefined
          ? {
              questionAnswer: {
                requestId: request.id,
                answers: command.answers,
                attachmentsByQuestionId: {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            }
          : {}),
      },
    });
  const ask = projection.thread.asks?.find(
    (entry) =>
      entry.status === "pending" &&
      entry.source.kind === "native" &&
      entry.source.requestId === request.id,
  );
  if (ask && command.answers) {
    const round = ask.rounds.at(-1)!;
    const answers = round.questionIds.flatMap((questionId) => {
      const value = command.answers?.[questionId];
      return isJson(value) ? [{ questionId, value }] : [];
    });
    if (answers.length) {
      const updated = applyAskCommand(
        projection.thread.asks ?? [],
        {
          type: "thread.ask.answer",
          commandId: command.commandId,
          threadId: projection.thread.id,
          askId: ask.id,
          round: round.number,
          answers,
          deferredQuestionIds: [],
          answeredBy: answerer,
        },
        DateTime.formatIso(ctx.now),
      );
      if (updated.ok)
        events.push(
          threadEvent(ctx, "thread.metadata-updated", {
            ...projection.thread,
            asks: updated.asks,
            updatedAt: ctx.now,
          }),
        );
    }
  }
  if (request.responseCapability.type === "message" && item?.type === "user_input_request") {
    const sent = deliver(
      projection,
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: projection.thread.id,
        messageId: MessageId.make(`runtime-answer:${command.commandId}`),
        text: item.questions
          .map(
            (question) =>
              `${question.question}\n${typeof command.answers?.[question.id] === "string" ? command.answers[question.id] : JSON.stringify(command.answers?.[question.id])}`,
          )
          .join("\n\n"),
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
      ctx,
    );
    if (sent._tag === "rejected") return sent;
    events.push(...sent.events);
  }
  return { _tag: "accepted", events };
}

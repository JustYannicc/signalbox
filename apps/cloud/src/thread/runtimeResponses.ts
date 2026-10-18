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
import {
  answerRequestEvents,
  isCloudApprovalRequest,
  respondToRuntimeRequest,
  runtimeRequestContext,
} from "./runtimeRequests.ts";
import { activeRun } from "./runLifecycle.ts";
import { canSteer } from "./steering.ts";
import { applyEvents } from "./threadProjection.ts";
import { type Decision, type DecisionContext, threadEvent } from "./threadEvents.ts";

type Response = Extract<
  OrchestrationV2Command,
  { type: "runtime-request.respond" | "thread.user-input.dismiss" }
>;
type Message = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
const isJson = Schema.is(Schema.Json);

export function canAnswerLiveRequest(
  projection: OrchestrationV2ThreadProjection,
  request: OrchestrationV2RuntimeRequest,
) {
  if (request.status !== "pending" || request.responseCapability.type !== "live") return false;
  const context = runtimeRequestContext(projection, request);
  const turn = projection.providerTurns.find((entry) => entry.id === request.providerTurnId);
  return (
    context?.session != null &&
    context.session.status !== "stopped" &&
    context.session.status !== "error" &&
    (request.providerTurnId === null || turn?.status === "running")
  );
}

/** Native validation and delivery share one decision with the durable public mirror. */
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
  const request = projection.runtimeRequests.find((entry) => entry.id === command.requestId);
  if (
    command.type === "runtime-request.respond" &&
    request !== undefined &&
    isCloudApprovalRequest(projection, request)
  ) {
    if (answerer.kind !== "person")
      return { _tag: "rejected", message: "Only a person can answer a secret-send approval." };
    const answered = answerRequestEvents(projection, request.id, command.decision, ctx);
    return typeof answered === "string"
      ? { _tag: "rejected", message: answered }
      : { _tag: "accepted", events: answered };
  }
  const item = projection.turnItems.find(
    (entry) => entry.type === "user_input_request" && entry.requestId === command.requestId,
  );
  const cancelled =
    command.type === "thread.user-input.dismiss" ||
    command.decision === "cancel" ||
    command.decision === "decline";
  if (
    !cancelled &&
    item?.type === "user_input_request" &&
    item.questions.some((question) => question.native?.isSecret === true)
  )
    return { _tag: "rejected", message: "Use a secret request or URL elicitation for secrets." };
  if (
    !cancelled &&
    command.type === "runtime-request.respond" &&
    item?.type === "user_input_request" &&
    Object.keys(command.answers ?? {}).some(
      (key) => !item.questions.some((question) => question.id === key),
    )
  )
    return { _tag: "rejected", message: "This response contains an unknown question." };
  const resolved = respondToRuntimeRequest(projection, command, ctx);
  if (resolved._tag === "rejected") return resolved;
  const events: OrchestrationV2DomainEvent[] = [...resolved.events];
  const ask = projection.thread.asks?.find(
    (entry) =>
      entry.status === "pending" &&
      entry.source.kind === "native" &&
      entry.source.requestId === command.requestId,
  );
  if (ask) {
    const updated = cancelled
      ? applyAskCommand(
          projection.thread.asks ?? [],
          {
            type: "thread.ask.withdraw",
            commandId: command.commandId,
            threadId: projection.thread.id,
            askId: ask.id,
          },
          DateTime.formatIso(ctx.now),
        )
      : command.type === "runtime-request.respond" && command.answers
        ? applyAskCommand(
            projection.thread.asks ?? [],
            {
              type: "thread.ask.answer",
              commandId: command.commandId,
              threadId: projection.thread.id,
              askId: ask.id,
              round: ask.rounds.at(-1)!.number,
              answers: ask.rounds.at(-1)!.questionIds.flatMap((questionId) => {
                const value = command.answers?.[questionId];
                return isJson(value) ? [{ questionId, value }] : [];
              }),
              deferredQuestionIds: [],
              answeredBy: answerer,
            },
            DateTime.formatIso(ctx.now),
          )
        : null;
    if (updated?.ok)
      events.push(
        threadEvent(ctx, "thread.metadata-updated", {
          ...projection.thread,
          asks: updated.asks,
          updatedAt: ctx.now,
        }),
      );
  }
  if (cancelled || request?.responseCapability.type !== "message")
    return { _tag: "accepted", events };
  if (item?.type !== "user_input_request" || command.type !== "runtime-request.respond")
    return { _tag: "rejected", message: "The question for this request was not found." };
  const replies = item.questions.flatMap((question) => {
    const value = command.answers?.[question.id];
    if (value === undefined) return [];
    return [
      `${question.question}\n${typeof value === "string" ? value.trim() : JSON.stringify(value)}`,
    ];
  });
  const live = activeRun(projection);
  const sent = deliver(
    applyEvents(projection, events) ?? projection,
    {
      type: "message.dispatch",
      commandId: command.commandId,
      threadId: command.threadId,
      messageId: MessageId.make(`async-answer:${command.requestId}`),
      text: replies.join("\n\n"),
      attachments: [],
      createdBy: answerer.kind === "person" ? "user" : "agent",
      creationSource: "server",
      dispatchMode:
        live !== undefined && canSteer(projection, live)
          ? { type: "steer_active", targetRunId: live.id }
          : { type: "queue_after_active" },
    },
    ctx,
  );
  return sent._tag === "rejected"
    ? sent
    : { _tag: "accepted", events: [...events, ...sent.events] };
}

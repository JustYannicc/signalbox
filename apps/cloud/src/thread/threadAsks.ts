import { canAnswerLiveRequest } from "./runtimeResponses.ts";
import {
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { SignalboxAskServerCommand } from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand, nativeAskAnswerMessage } from "@t3tools/shared/signalboxAsks";
import * as DateTime from "effect/DateTime";

import type { Decision } from "./threadDecider.ts";
import { type DecisionContext, threadEvent } from "./threadEvents.ts";

type Projection = OrchestrationV2ThreadProjection;
type Message = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
type Response = Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>;

/** An answer and its delivery commit together, so a freed machine can pick up the message. */
export function decideAsk(
  projection: Projection,
  command: SignalboxAskServerCommand,
  ctx: DecisionContext,
  deliver: (projection: Projection, message: Message, ctx: DecisionContext) => Decision,
  respond: (projection: Projection, response: Response, ctx: DecisionContext) => Decision,
): Decision {
  if (projection.thread.archivedAt !== null && command.type !== "thread.ask.sync")
    return { _tag: "rejected", message: "Reopen this thread before raising or answering an ask." };
  const previous =
    command.type === "thread.ask.sync"
      ? undefined
      : projection.thread.asks?.find((ask) => ask.id === command.askId);
  if (command.type === "thread.ask.withdraw" && previous?.source.kind === "automation")
    return { _tag: "rejected", message: "Cancel the automation instead of withdrawing its ask." };
  if (command.type === "thread.ask.answer" && previous?.source.kind === "automation")
    return {
      _tag: "rejected",
      message: "Answer this ask through its automation so its form is validated.",
    };
  const result = applyAskCommand(
    projection.thread.asks ?? [],
    command,
    DateTime.formatIso(ctx.now),
  );
  if (!result.ok) return { _tag: "rejected", message: result.error };
  const thread = { ...projection.thread, asks: result.asks, updatedAt: ctx.now };
  const changed = threadEvent(ctx, "thread.metadata-updated", thread);
  const answered = result.answered;
  if (answered === undefined) return { _tag: "accepted", events: [changed] };
  const source = answered.ask.source;
  const withAsk = { ...projection, thread };
  if (source.kind === "native") {
    const request = projection.runtimeRequests.find((entry) => entry.id === source.requestId);
    const item = projection.turnItems.find(
      (entry) => entry.type === "user_input_request" && entry.requestId === source.requestId,
    );
    const containsSecret =
      item?.type === "user_input_request" &&
      item.questions.some((question) => question.native?.isSecret === true);
    // The public mirror cannot complete a callback that also requires secrets.
    if (!containsSecret && request !== undefined && canAnswerLiveRequest(projection, request)) {
      // A live callback takes the complete answer once. Earlier rounds stay durable while it waits.
      if (answered.ask.status !== "answered") return { _tag: "accepted", events: [changed] };
      const response = respond(
        withAsk,
        {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: thread.id,
          requestId: source.requestId,
          answers: Object.fromEntries(
            answered.ask.rounds.flatMap((round) =>
              round.answers.map((answer) => [answer.questionId, answer.value]),
            ),
          ),
        },
        ctx,
      );
      if (response._tag === "rejected") return response;
      const comments = answered.ask.rounds.flatMap((round) => [
        ...(round.comment?.trim() ? [`Round ${round.number}: ${round.comment}`] : []),
        ...round.answers.flatMap((answer) =>
          answer.comment?.trim() ? [`[${answer.questionId}] ${answer.comment}`] : [],
        ),
      ]);
      if (!comments.length) return { _tag: "accepted", events: [changed, ...response.events] };
      const sent = deliver(
        withAsk,
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: thread.id,
          messageId: MessageId.make(`ask-comments:${command.commandId}`),
          text: `Comments on ask ${answered.ask.id}:\n\n${comments.join("\n\n")}`,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        },
        ctx,
      );
      return sent._tag === "rejected"
        ? sent
        : { _tag: "accepted", events: [changed, ...response.events, ...sent.events] };
    }
  }
  const sent = deliver(
    withAsk,
    {
      type: "message.dispatch",
      commandId: command.commandId,
      threadId: thread.id,
      messageId: MessageId.make(`ask-answer:${command.commandId}`),
      text:
        source.kind === "native" &&
        projection.runtimeRequests.find((entry) => entry.id === source.requestId)?.status !==
          "resolved"
          ? nativeAskAnswerMessage(answered.ask)
          : answered.message,
      attachments: [],
      createdBy:
        command.type === "thread.ask.answer" && command.answeredBy.kind === "person"
          ? "user"
          : "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    },
    ctx,
  );
  return sent._tag === "rejected" ? sent : { _tag: "accepted", events: [changed, ...sent.events] };
}

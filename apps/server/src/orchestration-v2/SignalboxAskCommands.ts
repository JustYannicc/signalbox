import {
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { SignalboxAskCommand } from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand } from "@t3tools/shared/signalboxAsks";

type AnswerDelivery = Extract<
  OrchestrationV2Command,
  { type: "message.dispatch" | "runtime-request.respond" }
>;

export function planAskCommand(
  command: SignalboxAskCommand,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runtimeRequests" | "providerSessions" | "turnItems"
  >,
  now: string,
) {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null)
    return { ok: false as const, error: "This thread is archived or deleted." };
  const result = applyAskCommand(projection.thread.asks ?? [], command, now);
  if (!result.ok) return result;
  const answered = result.answered;
  if (!answered) return { ...result, deliveries: [] as AnswerDelivery[] };
  if (answered.ask.source.kind === "automation")
    return { ok: false as const, error: "Answer through the automation engine." };
  const requestId =
    answered.ask.source.kind === "native" ? answered.ask.source.requestId : undefined;
  const request = projection.runtimeRequests.find((request) => request.id === requestId);
  const nativeItem = projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === requestId,
  );
  const containsSecret =
    nativeItem?.type === "user_input_request" &&
    nativeItem.questions.some((question) => question.native?.isSecret === true);
  const capability = request?.responseCapability;
  const live =
    capability?.type === "live" &&
    projection.providerSessions.some(
      (session) =>
        session.id === capability.providerSessionId &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
  // Partial rounds cannot complete a provider's synchronous callback.
  if (
    request?.status === "pending" &&
    live &&
    !containsSecret &&
    answered.ask.status === "answered"
  ) {
    const answers = Object.fromEntries(
      answered.ask.rounds.flatMap((round) =>
        round.answers.map((answer) => [answer.questionId, answer.value]),
      ),
    );
    const deliveries: AnswerDelivery[] = [
      {
        type: "runtime-request.respond",
        commandId: command.commandId,
        threadId: command.threadId,
        requestId: request.id,
        answers,
      },
    ];
    if (
      command.type === "thread.ask.answer" &&
      (command.comment?.trim() || command.answers.some((answer) => answer.comment?.trim()))
    ) {
      deliveries.push({
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: MessageId.make(`ask-answer:${command.commandId}`),
        text: answered.message,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
    }
    return { ...result, deliveries };
  }
  return {
    ...result,
    deliveries: [
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: MessageId.make(`ask-answer:${command.commandId}`),
        text: answered.message,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
    ] satisfies AnswerDelivery[],
  };
}

import * as Array from "effect/Array";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import * as DateTime from "effect/DateTime";
import { applyAskCommand } from "./signalboxAsks.ts";

const isJson = Schema.is(Schema.Json);

export function mirrorNativeAskEvents(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runtimeRequests" | "turnItems">,
  events: readonly OrchestrationV2DomainEvent[],
): readonly OrchestrationV2DomainEvent[] {
  let thread = projection.thread;
  const requests = new Map(projection.runtimeRequests.map((request) => [request.id, request]));
  const items = new Map(projection.turnItems.map((item) => [item.id, item]));
  const affected = new Set<string>();
  let last: OrchestrationV2DomainEvent | undefined;
  for (const event of events) {
    if (event.threadId !== thread.id) continue;
    last = event;
    if ("archivedAt" in event.payload && "modelSelection" in event.payload) thread = event.payload;
    if (event.type === "runtime-request.updated") {
      requests.set(event.payload.id, event.payload);
      if (event.payload.kind === "user_input") affected.add(event.payload.id);
    }
    if (event.type === "turn-item.updated") {
      items.set(event.payload.id, event.payload);
      if (event.payload.type === "user_input_request") affected.add(event.payload.requestId);
    }
  }
  if (!last) return events;
  let asks = thread.asks ?? [];
  const now = DateTime.formatIso(last.occurredAt);
  for (const requestId of affected) {
    const request = [...requests.values()].find((candidate) => candidate.id === requestId);
    const item = [...items.values()].find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === requestId,
    );
    if (!request || item?.type !== "user_input_request") continue;
    let ask = asks.find(
      (candidate) => candidate.source.kind === "native" && candidate.source.requestId === requestId,
    );
    const questions: SignalboxAskQuestion[] = item.questions
      .filter((question) => question.native?.isSecret !== true)
      .map((question) => ({
        id: question.id,
        question: question.question,
        why: "The agent requested input through its provider.",
        unblocks: "The work waiting on this answer.",
        recommendation: question.initialAnswer ?? null,
        options: question.options.map((option) => ({
          ...option,
          value: option.value ?? option.label,
        })),
        ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        blocking: question.native?.isBlocking ?? true,
        decisionOwner: "Thread owner",
        surface: {
          kind: "kit",
          component: "native-question",
          props: {
            header: question.header,
            native: { isSecret: false, isBlocking: question.native?.isBlocking ?? true },
            ...(question.allowCustomAnswer === undefined
              ? {}
              : { allowCustomAnswer: question.allowCustomAnswer }),
            ...(question.required === undefined ? {} : { required: question.required }),
          },
        },
      }));
    if (!ask && questions.length) {
      const [first, ...rest] = questions;
      if (!first) continue;
      const raised = applyAskCommand(
        asks,
        {
          type: "thread.ask.raise",
          commandId: CommandId.make(`native-ask:${requestId}`),
          threadId: thread.id,
          askId: `native:${requestId}`,
          ask: {
            kind: "blocker",
            source: { kind: "native", requestId: request.id },
            questions: [first, ...rest],
          },
        },
        now,
      );
      if (!raised.ok) continue;
      asks = raised.asks;
      ask = asks.at(-1);
    }
    if (!ask || ask.status !== "pending" || request.status !== "resolved" || !request.answers)
      continue;
    const answers = ask.rounds.at(-1)!.questionIds.flatMap((id) => {
      const value = request.answers?.[id];
      return !isJson(value) ? [] : [{ questionId: id, value }];
    });
    if (!answers.length) continue;
    const answered = applyAskCommand(
      asks,
      {
        type: "thread.ask.answer",
        commandId: CommandId.make(`native-answer:${requestId}`),
        threadId: thread.id,
        askId: ask.id,
        round: ask.rounds.at(-1)!.number,
        answers,
        deferredQuestionIds: [],
        answeredBy: { kind: "person", personId: "thread-owner" },
      },
      now,
    );
    if (answered.ok) asks = answered.asks;
  }
  if (thread.archivedAt !== null && asks.some((ask) => ask.status === "pending"))
    asks = asks.map((ask) =>
      ask.status !== "pending"
        ? ask
        : {
            ...ask,
            status: "archived",
            updatedAt: now,
            rounds: Array.map(ask.rounds, (round) =>
              round.closedAt === null ? { ...round, closedAt: now } : round,
            ),
          },
    );
  if (asks === thread.asks || (!asks.length && !thread.asks)) return events;
  return [
    ...events,
    {
      type: "thread.metadata-updated",
      id: EventId.make(`${last.id}:asks`),
      threadId: thread.id,
      occurredAt: last.occurredAt,
      payload: { ...thread, asks, updatedAt: last.occurredAt },
    },
  ];
}

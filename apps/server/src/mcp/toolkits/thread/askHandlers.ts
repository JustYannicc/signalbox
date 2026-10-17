import { CommandId, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import { SIGNALBOX_ASK_TOOLS } from "@t3tools/contracts/signalboxAskTools";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId, readThread } from "../../threadAccess.ts";

const writes = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (input: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((input: P) => [input.threadId], handle);

export const askHandlers = {
  t3_ask_raise: writes((input: typeof SIGNALBOX_ASK_TOOLS.t3_ask_raise.parameters.Type) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const threadId = projection.thread.id;
      const commandId =
        input.clientRequestId === undefined
          ? yield* newCommandId()
          : CommandId.make(`ask:${threadId}:${input.clientRequestId}`);
      const askId = input.askId ?? `ask:${commandId}`;
      const result = yield* threads
        .dispatch({
          type: "thread.ask.raise",
          commandId,
          threadId,
          askId,
          ask: { kind: input.kind, questions: input.questions, source: { kind: "agent" } },
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { askId, round: 1, sequence: result.sequence };
    }),
  ),
  t3_ask_list: McpToolAccess.reads(
    (input: typeof SIGNALBOX_ASK_TOOLS.t3_ask_list.parameters.Type) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        return {
          asks: (projection.thread.asks ?? []).filter(
            (ask) => input.includeClosed || ask.status === "pending",
          ),
        };
      }),
  ),
  t3_ask_read: McpToolAccess.reads(
    (input: typeof SIGNALBOX_ASK_TOOLS.t3_ask_read.parameters.Type) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const ask = projection.thread.asks?.find((ask) => ask.id === input.askId);
        if (!ask)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The ask was not found.",
          });
        return { ask };
      }),
  ),
  t3_ask_answer: writes((input: typeof SIGNALBOX_ASK_TOOLS.t3_ask_answer.parameters.Type) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      if (!caller)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Answer from an assistant thread so its provenance can be recorded.",
        });
      const result = yield* threads
        .dispatch({
          type: "thread.ask.answer",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
          askId: input.askId,
          round: input.round,
          answers: input.answers,
          deferredQuestionIds: input.deferredQuestionIds ?? [],
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          answeredBy: { kind: "assistant", personId: "local-user", assistantThreadId: caller.id },
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_ask_withdraw: writes((input: typeof SIGNALBOX_ASK_TOOLS.t3_ask_withdraw.parameters.Type) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const result = yield* threads
        .dispatch({
          type: "thread.ask.withdraw",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
          askId: input.askId,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
};

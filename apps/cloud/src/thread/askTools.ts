import { CommandId, ThreadId } from "@t3tools/contracts";
import { SIGNALBOX_ASK_TOOLS } from "@t3tools/contracts/signalboxAskTools";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ownerActor } from "../automations/cloudThreads.ts";
import * as CloudThreadService from "./CloudThreadService.ts";

const decodeRaise = Schema.decodeUnknownEffect(SIGNALBOX_ASK_TOOLS.t3_ask_raise.parameters);
const decodeList = Schema.decodeUnknownEffect(SIGNALBOX_ASK_TOOLS.t3_ask_list.parameters);
const decodeRead = Schema.decodeUnknownEffect(SIGNALBOX_ASK_TOOLS.t3_ask_read.parameters);
const decodeAnswer = Schema.decodeUnknownEffect(SIGNALBOX_ASK_TOOLS.t3_ask_answer.parameters);
const decodeWithdraw = Schema.decodeUnknownEffect(SIGNALBOX_ASK_TOOLS.t3_ask_withdraw.parameters);

class AskNotFound extends Schema.TaggedError<AskNotFound>()("AskNotFound", {}) {
  override get message() {
    return "The ask was not found.";
  }
}

export const isAskTool = (name: string): name is keyof typeof SIGNALBOX_ASK_TOOLS =>
  Object.hasOwn(SIGNALBOX_ASK_TOOLS, name);

/** The machine's drive token names its caller; tool input cannot impersonate another thread. */
export const askTool = (
  callerThreadId: string,
  name: keyof typeof SIGNALBOX_ASK_TOOLS,
  input: unknown,
) =>
  Effect.gen(function* () {
    const threads = yield* CloudThreadService.CloudThreadService;
    const actor = yield* ownerActor;
    const caller = ThreadId.make(callerThreadId);
    const target = (id: ThreadId | undefined) => id ?? caller;
    const commandId = () =>
      Effect.flatMap(Crypto.Crypto, (crypto) => Effect.map(crypto.randomUUIDv4(), CommandId.make));
    switch (name) {
      case "t3_ask_raise": {
        const params = yield* decodeRaise(input);
        const threadId = target(params.threadId);
        const fresh = yield* commandId();
        const askId = params.askId ?? `ask:${caller}:${params.clientRequestId ?? fresh}`;
        const result = yield* threads.dispatchCommand(actor, {
          type: "thread.ask.raise",
          commandId: params.clientRequestId
            ? CommandId.make(`ask-raise:${caller}:${params.clientRequestId}`)
            : fresh,
          threadId,
          askId,
          ask: { kind: params.kind, questions: params.questions, source: { kind: "agent" } },
        });
        return { askId, round: 1, sequence: result.sequence };
      }
      case "t3_ask_list": {
        const params = yield* decodeList(input);
        const snapshot = yield* threads.threadSnapshot(actor, target(params.threadId));
        return {
          asks: (snapshot.projection.thread.asks ?? []).filter(
            (ask) => params.includeClosed || ask.status === "pending",
          ),
        };
      }
      case "t3_ask_read": {
        const params = yield* decodeRead(input);
        const snapshot = yield* threads.threadSnapshot(actor, target(params.threadId));
        const ask = snapshot.projection.thread.asks?.find((entry) => entry.id === params.askId);
        if (ask === undefined) return yield* new AskNotFound();
        return { ask };
      }
      case "t3_ask_answer": {
        const params = yield* decodeAnswer(input);
        return yield* threads.answerAskAsAssistant(actor, caller, {
          ...params,
          type: "thread.ask.answer",
          threadId: target(params.threadId),
          commandId: yield* commandId(),
          deferredQuestionIds: params.deferredQuestionIds ?? [],
          answeredBy: { kind: "assistant", personId: actor.userId, assistantThreadId: caller },
        });
      }
      case "t3_ask_withdraw": {
        const params = yield* decodeWithdraw(input);
        return yield* threads.dispatchCommand(actor, {
          ...params,
          type: "thread.ask.withdraw",
          threadId: target(params.threadId),
          commandId: yield* commandId(),
        });
      }
    }
  }).pipe(
    Effect.map((result) => ({ _tag: "ok" as const, result })),
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "failed" as const,
        message:
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : "The ask could not be changed.",
      }),
    ),
  );

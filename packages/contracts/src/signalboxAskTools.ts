import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SignalboxAsk, SignalboxAskAnswerInput, SignalboxAskQuestion } from "./signalboxAsks.ts";
import { SignalboxAskConsideringDraft } from "./signalboxConsidering.ts";

const target = { threadId: Schema.optional(ThreadId) };
const askTarget = { ...target, askId: TrimmedNonEmptyString };
const sequence = Schema.Struct({ sequence: Schema.Number });
const raiseFields = {
  ...target,
  askId: Schema.optional(TrimmedNonEmptyString),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
  questions: Schema.NonEmptyArray(SignalboxAskQuestion),
};
const raiseParameters = Schema.Struct({
  ...raiseFields,
  kind: Schema.Literals(["blocker", "ready", "considering"]),
  considering: Schema.optional(SignalboxAskConsideringDraft),
});
export const SIGNALBOX_ASK_TOOLS = {
  t3_ask_raise: {
    description:
      "Raise a durable Blocker, Ready or Considering ask. Considering asks include a date, event or evidence exit and preparation attachment IDs. Include why, what answering unblocks and whose decision it is. Free text is always allowed. Non-blocking questions let you keep working. Never ask for secrets here; use request_secret or URL elicitation. Reuse clientRequestId or askId when retrying.",
    parameters: raiseParameters,
    success: Schema.Struct({
      askId: TrimmedNonEmptyString,
      round: Schema.Number,
      sequence: Schema.Number,
    }),
    readonly: false,
  },
  t3_ask_list: {
    description:
      "List this thread's pending durable asks. Set includeClosed to include answered, withdrawn and archived asks.",
    parameters: Schema.Struct({ ...target, includeClosed: Schema.optional(Schema.Boolean) }),
    success: Schema.Struct({ asks: Schema.Array(SignalboxAsk) }),
    readonly: true,
  },
  t3_ask_read: {
    description: "Read a durable ask, its questions, rounds and answer history.",
    parameters: Schema.Struct(askTarget),
    success: Schema.Struct({ ask: SignalboxAsk }),
    readonly: true,
  },
  t3_ask_answer: {
    description:
      "Answer an ask on the person's behalf. The current round is required; unanswered questions carry to the next round. A comment can accompany any answer. Provenance records the calling assistant.",
    parameters: Schema.Struct({
      ...askTarget,
      round: Schema.Int.check(Schema.isGreaterThan(0)),
      answers: Schema.Array(SignalboxAskAnswerInput),
      deferredQuestionIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      comment: Schema.optional(Schema.String),
    }),
    success: sequence,
    readonly: false,
  },
  t3_ask_withdraw: {
    description:
      "Withdraw a pending ask when its answer is no longer needed. Keeps the history; retries are harmless.",
    parameters: Schema.Struct(askTarget),
    success: sequence,
    readonly: false,
  },
} as const;

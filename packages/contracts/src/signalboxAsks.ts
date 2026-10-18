import * as Schema from "effect/Schema";
import { ProviderUserInputAnswers } from "./providerPolicy.ts";

import {
  CommandId,
  IsoDateTime,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const SignalboxAskKind = Schema.Literals(["blocker", "ready", "considering"]);
export type SignalboxAskKind = typeof SignalboxAskKind.Type;

export const SignalboxAskOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: Schema.Json,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
});

/** #669 renders this description. Custom HTML stays data until its sandbox is available. */
export const SignalboxAskSurface = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("kit"),
    component: TrimmedNonEmptyString,
    props: Schema.optional(Schema.Json),
  }),
  Schema.Struct({ kind: Schema.Literal("html"), html: Schema.String }),
]);

export const SignalboxAskQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
  unblocks: TrimmedNonEmptyString,
  recommendation: Schema.Json,
  options: Schema.Array(SignalboxAskOption),
  multiSelect: Schema.optional(Schema.Boolean),
  blocking: Schema.Boolean,
  /** Named people or interests; upward routing resolves these in #675. */
  decisionOwner: TrimmedNonEmptyString,
  deciderIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  surface: SignalboxAskSurface,
});
export type SignalboxAskQuestion = typeof SignalboxAskQuestion.Type;

export const SignalboxAskSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent") }),
  Schema.Struct({ kind: Schema.Literal("native"), requestId: RuntimeRequestId }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    runId: TrimmedNonEmptyString,
    stepKey: TrimmedNonEmptyString,
  }),
]);

export const SignalboxAskDraft = Schema.Struct({
  kind: SignalboxAskKind,
  questions: Schema.NonEmptyArray(SignalboxAskQuestion),
  source: SignalboxAskSource,
});
export type SignalboxAskDraft = typeof SignalboxAskDraft.Type;

export const SignalboxAskAnswerer = Schema.Struct({
  kind: Schema.Literals(["person", "assistant"]),
  /** The person answering, or represented by the assistant. */
  personId: TrimmedNonEmptyString,
  assistantThreadId: Schema.optional(ThreadId),
});
export type SignalboxAskAnswerer = typeof SignalboxAskAnswerer.Type;

export const SignalboxAskAnswerInput = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  value: Schema.Json,
  /** Free text accompanies any answer, including a structured kit answer. */
  comment: Schema.optional(Schema.String),
});
export const SignalboxAskAnswer = Schema.Struct({
  ...SignalboxAskAnswerInput.fields,
  answeredBy: SignalboxAskAnswerer,
  recommendationTaken: Schema.Boolean,
  answeredAt: IsoDateTime,
});

export const SignalboxAskRound = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  questionIds: Schema.Array(TrimmedNonEmptyString),
  answers: Schema.Array(SignalboxAskAnswer),
  deferredQuestionIds: Schema.Array(TrimmedNonEmptyString),
  comment: Schema.optional(Schema.String),
  openedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});

export const SignalboxAsk = Schema.Struct({
  ...SignalboxAskDraft.fields,
  id: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "answered", "withdrawn", "archived"]),
  rounds: Schema.NonEmptyArray(SignalboxAskRound),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SignalboxAsk = typeof SignalboxAsk.Type;

export const SignalboxAskThreadFields = { asks: Schema.optional(Schema.Array(SignalboxAsk)) };

const target = { commandId: CommandId, threadId: ThreadId, askId: TrimmedNonEmptyString };
export const SignalboxAskRaiseCommand = Schema.Struct({
  type: Schema.Literal("thread.ask.raise"),
  ...target,
  ask: SignalboxAskDraft,
});
export const SignalboxAskAnswerCommand = Schema.Struct({
  type: Schema.Literal("thread.ask.answer"),
  ...target,
  /** Optimistic concurrency: stale forms cannot answer a later round. */
  round: Schema.Int.check(Schema.isGreaterThan(0)),
  answers: Schema.Array(SignalboxAskAnswerInput),
  deferredQuestionIds: Schema.Array(TrimmedNonEmptyString),
  comment: Schema.optional(Schema.String),
  answeredBy: SignalboxAskAnswerer,
});
export const SignalboxAskWithdrawCommand = Schema.Struct({
  type: Schema.Literal("thread.ask.withdraw"),
  ...target,
});
/** Automation engines synchronize their journaled ask after validating a step's answer. */
export const SignalboxAskSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.ask.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  ask: SignalboxAsk,
});
export const SignalboxAskCommands = [
  SignalboxAskRaiseCommand,
  SignalboxAskAnswerCommand,
  SignalboxAskWithdrawCommand,
] as const;
export const SignalboxAskCommand = Schema.Union(SignalboxAskCommands);
export type SignalboxAskCommand = typeof SignalboxAskCommand.Type;

export const SignalboxAskServerCommand = Schema.Union([
  ...SignalboxAskCommands,
  SignalboxAskSyncCommand,
]);
export type SignalboxAskServerCommand = typeof SignalboxAskServerCommand.Type;

/** Only the MCP handler supplies the authenticated assistant caller. */
export const SignalboxNativeAskRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.native-ask.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  answers: ProviderUserInputAnswers,
  answeredBy: SignalboxAskAnswerer,
});

import {
  OrchestrationV2ProviderThread,
  ProviderFeedbackFailure,
  ProviderUploadFeedbackResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const FeedbackRequest = Schema.Struct({
  type: Schema.Literal("feedback.upload"),
  requestId: TrimmedNonEmptyString,
  providerThread: OrchestrationV2ProviderThread,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type FeedbackRequest = typeof FeedbackRequest.Type;

export const FeedbackOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("uploaded"), ...ProviderUploadFeedbackResult.fields }),
  Schema.Struct({ _tag: Schema.Literal("failed"), failure: ProviderFeedbackFailure }),
]);
export type FeedbackOutcome = typeof FeedbackOutcome.Type;

export const FeedbackResponse = Schema.Struct({
  type: Schema.Literal("feedback.result"),
  requestId: TrimmedNonEmptyString,
  outcome: FeedbackOutcome,
});
export type FeedbackResponse = typeof FeedbackResponse.Type;

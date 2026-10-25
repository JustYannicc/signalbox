import * as Schema from "effect/Schema";

import {
  MessageId,
  ThreadId,
  ProviderThreadId,
  RunId,
  TrimmedNonEmptyString,
  NonNegativeInt,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ProviderContinuationBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export const ProviderContinuationObservationRef = Schema.Struct({
  sdkMessageId: TrimmedNonEmptyString,
  blockIndex: NonNegativeInt,
});

/** SDK observations carry no claim about the recorded source occurrence. */
export const ProviderContinuationObservation = Schema.Struct({
  ...ProviderContinuationObservationRef.fields,
  observedCallId: Schema.optional(TrimmedNonEmptyString),
  block: ProviderContinuationBlock,
});
export type ProviderContinuationObservation = typeof ProviderContinuationObservation.Type;

/** Source identities come from the producer's explicit binding, never from SDK position. */
export const ProviderContinuationCompletion = Schema.Struct({
  sourceCallId: TrimmedNonEmptyString,
  sourceOccurrenceId: TrimmedNonEmptyString,
  observation: Schema.optional(ProviderContinuationObservationRef),
  block: ProviderContinuationBlock,
});
export type ProviderContinuationCompletion = typeof ProviderContinuationCompletion.Type;

export const ProviderContinuation = Schema.Struct({
  sourceRunId: RunId,
  providerThreadId: ProviderThreadId,
  driver: Schema.optional(ProviderDriverKind),
  observations: Schema.optional(Schema.NonEmptyArray(ProviderContinuationObservation)),
  completions: Schema.optional(Schema.NonEmptyArray(ProviderContinuationCompletion)),
});
export type ProviderContinuation = typeof ProviderContinuation.Type;

/** Observations and a later source binding enrich the existing message and run. */
export const ProviderContinuationAssociation = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  messageId: MessageId,
  providerContinuation: Schema.Struct({
    ...ProviderContinuation.fields,
    observations: Schema.NonEmptyArray(ProviderContinuationObservation),
  }),
});
export type ProviderContinuationAssociation = typeof ProviderContinuationAssociation.Type;

const sameBlock = Schema.toEquivalence(ProviderContinuationBlock);

/** Validates the supplied join's coverage and bytes; the producer owns its source evidence. */
export const continuationBlocksMatchObservations = (
  continuation: ProviderContinuation,
): boolean => {
  const { observations, completions } = continuation;
  if (observations === undefined || completions === undefined) return true;
  return (
    observations.length === completions.length &&
    completions.every((completion, index) => {
      const observed = observations[index]!;
      return (
        completion.observation?.sdkMessageId === observed.sdkMessageId &&
        completion.observation.blockIndex === observed.blockIndex &&
        sameBlock(completion.block, observed.block)
      );
    })
  );
};

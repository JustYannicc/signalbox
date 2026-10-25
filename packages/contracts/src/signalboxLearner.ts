import * as Schema from "effect/Schema";

/** Raw source-neutral evidence routed to one already-authorized learner home. */
export const SignalboxLearnerEvent = Schema.Struct({
  eventId: Schema.String,
  treeId: Schema.String,
  source: Schema.String,
  kind: Schema.Literals(["observation", "draft", "human_action"]),
  content: Schema.String,
  /** Task or question the source associates with this event, when available. */
  input: Schema.optional(Schema.String),
  objectId: Schema.optional(Schema.String),
  /** The served lens used to prepare this draft, if one was used. */
  usedLensId: Schema.optional(Schema.String),
});
export type SignalboxLearnerEvent = typeof SignalboxLearnerEvent.Type;

export const SignalboxLearnerLogEventInput = Schema.Struct({
  scope: Schema.String,
  event: SignalboxLearnerEvent,
});
export type SignalboxLearnerLogEventInput = typeof SignalboxLearnerLogEventInput.Type;

export const SignalboxLearnerStatementInput = Schema.Struct({
  scope: Schema.String,
  treeId: Schema.String,
  text: Schema.String,
  reason: Schema.String,
});
export type SignalboxLearnerStatementInput = typeof SignalboxLearnerStatementInput.Type;

export const SignalboxLearnerQueryInput = Schema.Struct({
  scope: Schema.String,
  task: Schema.String,
});
export type SignalboxLearnerQueryInput = typeof SignalboxLearnerQueryInput.Type;

export const SignalboxLearnerEventKind = Schema.Literals(["observation", "draft", "human_action"]);
export type SignalboxLearnerEventKind = typeof SignalboxLearnerEventKind.Type;

export const SignalboxLearnerClassification = Schema.Literals([
  "confirmed",
  "countermanded",
  "overridden",
  "ambiguous",
]);
export type SignalboxLearnerClassification = typeof SignalboxLearnerClassification.Type;

/** A paired decision. Returned only by queries within the same learner scope. */
export const SignalboxLearnerPrecedent = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  input: Schema.String,
  draft: Schema.String,
  action: Schema.String,
  classification: SignalboxLearnerClassification,
  reason: Schema.String,
  matchReason: Schema.String,
  createdAt: Schema.Number,
});
export type SignalboxLearnerPrecedent = typeof SignalboxLearnerPrecedent.Type;

/** Redacted lens view for a higher-level learner: no ids or source evidence. */
export const SignalboxLearnerLensSummary = Schema.Struct({
  text: Schema.String,
  ownerStated: Schema.Boolean,
  supports: Schema.Number,
  misses: Schema.Number,
  hitRate: Schema.Number,
});
export type SignalboxLearnerLensSummary = typeof SignalboxLearnerLensSummary.Type;

/** Full in-scope lens result; its id is needed to put the choice in the trail. */
export const SignalboxLearnerMatchedLens = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  reason: Schema.String,
  matchReason: Schema.String,
  ownerStated: Schema.Boolean,
  served: Schema.Boolean,
  supports: Schema.Number,
  misses: Schema.Number,
  hitRate: Schema.Number,
});
export type SignalboxLearnerMatchedLens = typeof SignalboxLearnerMatchedLens.Type;

export const SignalboxLearnerQueryResult = Schema.Struct({
  precedents: Schema.Array(SignalboxLearnerPrecedent),
  lenses: Schema.Array(SignalboxLearnerMatchedLens),
  answerAlone: Schema.Boolean,
  usedLensId: Schema.NullOr(Schema.String),
});
export type SignalboxLearnerQueryResult = typeof SignalboxLearnerQueryResult.Type;

/** `stored: false` means an earlier home already owns this event id. */
export const SignalboxLearnerLogResult = Schema.Struct({
  eventId: Schema.String,
  stored: Schema.Boolean,
  paired: Schema.Boolean,
  precedentId: Schema.optional(Schema.String),
});
export type SignalboxLearnerLogResult = typeof SignalboxLearnerLogResult.Type;

export const SignalboxLearnerSettings = Schema.Struct({
  /** Additional decisions beyond the seed that must support a learned lens before service. */
  minLaterSupports: Schema.Number,
  /** Minimum decayed hit rate for serving a lens. */
  minHitRate: Schema.Number,
  /** Exponential half-life for support and miss evidence. */
  halfLifeMs: Schema.Number,
  /** Minimum Jev relevance probability returned for query candidates. */
  relevanceThreshold: Schema.Number,
});
export type SignalboxLearnerSettings = typeof SignalboxLearnerSettings.Type;

export const SignalboxLearnerSettingsInput = Schema.Struct({
  scope: Schema.String,
  treeId: Schema.String,
  settings: SignalboxLearnerSettings,
});
export type SignalboxLearnerSettingsInput = typeof SignalboxLearnerSettingsInput.Type;

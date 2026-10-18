import * as Schema from "effect/Schema";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SignalboxContextId } from "./signalboxContexts.ts";

const SignalboxAskConsideringEventField = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);
const SignalboxAskConsideringEventValue = Schema.Union([
  SignalboxAskConsideringEventField,
  Schema.Array(SignalboxAskConsideringEventField),
]);

/** Same shallow scalar matcher used by workflow event `where` filters. */
export const SignalboxAskConsideringEventWhere = Schema.Record(
  Schema.String,
  SignalboxAskConsideringEventValue,
);
export type SignalboxAskConsideringEventWhere = typeof SignalboxAskConsideringEventWhere.Type;

export const SignalboxAskConsideringEvidenceSource = Schema.Literals([
  "thread.created",
  "message.sent",
  "drive.changed",
  "folder.note.changed",
]);
export type SignalboxAskConsideringEvidenceSource =
  typeof SignalboxAskConsideringEvidenceSource.Type;

export const SignalboxAskConsideringExit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("date"), at: IsoDateTime }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    name: TrimmedNonEmptyString,
    where: Schema.optional(SignalboxAskConsideringEventWhere),
  }),
  Schema.Struct({
    kind: Schema.Literal("evidence"),
    reference: TrimmedNonEmptyString,
    relatednessCriteria: TrimmedNonEmptyString,
    materialChangeCriteria: TrimmedNonEmptyString,
    sourceKinds: Schema.NonEmptyArray(SignalboxAskConsideringEvidenceSource),
  }),
]);
export type SignalboxAskConsideringExit = typeof SignalboxAskConsideringExit.Type;

export const SignalboxAskConsideringDraft = Schema.Struct({
  exit: SignalboxAskConsideringExit,
  preparationAttachmentIds: Schema.Array(ChatAttachmentId),
});
export type SignalboxAskConsideringDraft = typeof SignalboxAskConsideringDraft.Type;

export const SignalboxAskConsideringDateProof = Schema.Struct({
  kind: Schema.Literal("date"),
  at: IsoDateTime,
});
export const SignalboxAskConsideringEventProof = Schema.Struct({
  kind: Schema.Literal("event"),
  eventId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  matchedFields: Schema.Record(Schema.String, SignalboxAskConsideringEventField),
});
export const SignalboxAskConsideringEvidenceProof = Schema.Struct({
  kind: Schema.Literal("evidence"),
  source: SignalboxAskConsideringEvidenceSource,
  eventId: TrimmedNonEmptyString,
  judgment: Schema.Literal("materially_changes"),
});
export const SignalboxAskConsideringWeeklyReviewProof = Schema.Struct({
  kind: Schema.Literal("weekly-review"),
  reviewedAt: IsoDateTime,
  staleSince: IsoDateTime,
  automationRunId: TrimmedNonEmptyString,
});
export const SignalboxAskConsideringFireProof = Schema.Union([
  SignalboxAskConsideringDateProof,
  SignalboxAskConsideringEventProof,
  SignalboxAskConsideringEvidenceProof,
  SignalboxAskConsideringWeeklyReviewProof,
]);
export type SignalboxAskConsideringFireProof = typeof SignalboxAskConsideringFireProof.Type;

export const SignalboxAskConsideringOwnerProof = Schema.Struct({
  kind: Schema.Literal("owner"),
  whatChanged: TrimmedNonEmptyString,
});
export const SignalboxAskConsideringProof = Schema.Union([
  ...SignalboxAskConsideringFireProof.members,
  SignalboxAskConsideringOwnerProof,
]);
export type SignalboxAskConsideringProof = typeof SignalboxAskConsideringProof.Type;

const SignalboxAskConsideringFiredBase = {
  at: IsoDateTime,
  whatChanged: TrimmedNonEmptyString,
};
export const SignalboxAskConsideringFired = Schema.Union([
  Schema.Struct({
    ...SignalboxAskConsideringFiredBase,
    source: Schema.Literal("date"),
    proof: SignalboxAskConsideringDateProof,
  }),
  Schema.Struct({
    ...SignalboxAskConsideringFiredBase,
    source: Schema.Literal("event"),
    proof: SignalboxAskConsideringEventProof,
  }),
  Schema.Struct({
    ...SignalboxAskConsideringFiredBase,
    source: Schema.Literal("evidence"),
    proof: SignalboxAskConsideringEvidenceProof,
  }),
  Schema.Struct({
    ...SignalboxAskConsideringFiredBase,
    source: Schema.Literal("weekly-review"),
    proof: SignalboxAskConsideringWeeklyReviewProof,
  }),
  Schema.Struct({
    ...SignalboxAskConsideringFiredBase,
    source: Schema.Literal("owner"),
    proof: SignalboxAskConsideringOwnerProof,
  }),
]);
export type SignalboxAskConsideringFired = typeof SignalboxAskConsideringFired.Type;

export const SignalboxAskConsideringHome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cloud"),
    projectId: ProjectId,
    contextId: SignalboxContextId,
    driveId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("server"),
    projectId: ProjectId,
    workspaceRoot: TrimmedNonEmptyString,
  }),
]);
export type SignalboxAskConsideringHome = typeof SignalboxAskConsideringHome.Type;
export type SignalboxAskConsideringCloudHome = Extract<
  SignalboxAskConsideringHome,
  { readonly kind: "cloud" }
>;

export const SignalboxAskConsidering = Schema.Struct({
  ...SignalboxAskConsideringDraft.fields,
  /** Changes only when the item is deferred again; delayed fires carry this revision. */
  revision: PositiveInt,
  /** The current exit's age; answers and comments do not reset weekly review. */
  revisionAt: IsoDateTime,
  fired: Schema.optional(SignalboxAskConsideringFired),
});
export type SignalboxAskConsidering = typeof SignalboxAskConsidering.Type;

import type { PullRequestReviewCommentDraft } from "@t3tools/contracts";
import type { PullRequestWriteAttemptRecord } from "@t3tools/client-runtime/pull-request-write-attempt";
import * as Schema from "effect/Schema";
import { PullRequestReviewCommentDraft as CommentSchema } from "@t3tools/contracts";
import type { PullRequestParams } from "./usePullRequestDiff";

export type PendingReviewComment = PullRequestReviewCommentDraft & {
  readonly id: string;
  readonly headSha: string;
  readonly code: string;
};
export type ReviewDraft = {
  readonly summary: string;
  readonly comment: string;
  readonly comments: readonly PendingReviewComment[];
  readonly reviewedHeadSha?: string;
  readonly reviewWriteAttempt?: PullRequestWriteAttemptRecord;
  readonly commentWriteAttempt?: PullRequestWriteAttemptRecord;
};
export const EMPTY_REVIEW_DRAFT: ReviewDraft = { summary: "", comment: "", comments: [] };
export function pullRequestReviewKey(params: PullRequestParams) {
  return JSON.stringify([
    params.environmentId,
    params.projectId,
    params.host ?? "",
    params.repository,
    params.number,
  ]);
}
export const ReviewDraftDocument = Schema.Struct({
  version: Schema.Literal(1),
  drafts: Schema.Record(
    Schema.String,
    Schema.Struct({
      summary: Schema.String,
      comment: Schema.String,
      comments: Schema.Array(
        Schema.Struct({
          ...CommentSchema.fields,
          id: Schema.String,
          headSha: Schema.String,
          code: Schema.String,
        }),
      ),
      reviewedHeadSha: Schema.optional(Schema.String),
      reviewWriteAttempt: Schema.optional(
        Schema.Struct({
          requestKey: Schema.String,
          operationId: Schema.String,
          headSha: Schema.optional(Schema.String),
        }),
      ),
      commentWriteAttempt: Schema.optional(
        Schema.Struct({
          requestKey: Schema.String,
          operationId: Schema.String,
          headSha: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
export function clearSubmittedReview(current: ReviewDraft, submitted: ReviewDraft): ReviewDraft {
  const { reviewWriteAttempt: _reviewWriteAttempt, ...currentWithoutAttempt } = current;
  return {
    ...currentWithoutAttempt,
    summary: current.summary === submitted.summary ? "" : current.summary,
    comments: current.comments.filter(
      (comment) =>
        !submitted.comments.some(
          (saved) =>
            saved.id === comment.id &&
            saved.body === comment.body &&
            saved.headSha === comment.headSha &&
            saved.path === comment.path &&
            saved.oldPath === comment.oldPath &&
            saved.code === comment.code &&
            samePosition(saved.position, comment.position),
        ),
    ),
    ...(current.summary === submitted.summary
      ? { reviewedHeadSha: undefined }
      : current.reviewedHeadSha === undefined
        ? {}
        : { reviewedHeadSha: current.reviewedHeadSha }),
  };
}

export function clearCommentWriteAttempt(current: ReviewDraft, operationId: string): ReviewDraft {
  if (current.commentWriteAttempt?.operationId !== operationId) return current;
  const { commentWriteAttempt: _commentWriteAttempt, ...rest } = current;
  return rest;
}

function samePosition(
  left: PendingReviewComment["position"],
  right: PendingReviewComment["position"],
) {
  if (left.kind === "added" && right.kind === "added") return left.newLine === right.newLine;
  if (left.kind === "deleted" && right.kind === "deleted") return left.oldLine === right.oldLine;
  return (
    left.kind === "context" &&
    right.kind === "context" &&
    left.oldLine === right.oldLine &&
    left.newLine === right.newLine &&
    left.side === right.side
  );
}

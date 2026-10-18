import {
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestOperationId,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestReviewHeadSha,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PULL_REQUEST_REVIEW_TOOL = "pull_request_review";

// The drive token supplies the caller's thread and folder, never the tool arguments.
const target = { number: PullRequestRef.fields.number };
export const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read"), ...target }),
  Schema.Struct({
    action: Schema.Literal("reply"),
    ...target,
    threadId: PullRequestThreadReplyInput.fields.threadId,
    body: PullRequestThreadReplyInput.fields.body,
    operationId: PullRequestOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("resolve"),
    ...target,
    threadId: PullRequestThreadResolutionInput.fields.threadId,
    resolved: PullRequestThreadResolutionInput.fields.resolved,
  }),
  Schema.Struct({
    action: Schema.Literal("comment"),
    ...target,
    body: PullRequestCommentInput.fields.body,
    operationId: PullRequestOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("updateComment"),
    ...target,
    commentId: PullRequestCommentUpdateInput.fields.commentId,
    kind: PullRequestCommentUpdateInput.fields.kind,
    body: PullRequestCommentUpdateInput.fields.body,
  }),
  Schema.Struct({
    action: Schema.Literal("submitReview"),
    ...target,
    operationId: PullRequestOperationId,
    headSha: PullRequestReviewHeadSha,
    verdict: PullRequestSubmitReviewInput.fields.verdict,
    body: PullRequestSubmitReviewInput.fields.body,
    comments: PullRequestSubmitReviewInput.fields.comments,
  }),
  Schema.Struct({
    action: Schema.Literal("setReaction"),
    ...target,
    subjectId: PullRequestReactionInput.fields.subjectId,
    content: PullRequestReactionInput.fields.content,
    reacted: PullRequestReactionInput.fields.reacted,
  }),
]);
export type Request = typeof Request.Type;

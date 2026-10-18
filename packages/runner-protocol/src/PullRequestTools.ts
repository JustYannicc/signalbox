import * as Schema from "effect/Schema";

/** Sent through the authenticated tool route; the cloud supplies the thread and repository. */
export const AGENT_PULL_REQUEST_TOOL = "agent_pull_request";
export const PR_IMAGE_LIMIT = 10 * 1024 * 1024;

const NumberInput = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const target = { number: Schema.optional(NumberInput) };
const Body = Schema.String.check(Schema.isMaxLength(65_000));
const OperationId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/)).annotate({
  description:
    "A unique operation id. Reuse it when retrying this exact action to avoid duplicates.",
});

export const ReadPullRequest = Schema.Struct(target);
export const EditPullRequest = Schema.Struct({ ...target, body: Body });
export const CommentPullRequest = Schema.Struct({
  ...target,
  body: Body,
  operationId: OperationId,
});
export const ReplyPullRequest = Schema.Struct({
  ...target,
  commentId: NumberInput.annotate({ description: "The numeric review comment id from read_pr." }),
  body: Body,
  operationId: OperationId,
});
export const PullRequestImageType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const UploadPullRequestImage = Schema.Struct({
  ...target,
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)),
  mimeType: PullRequestImageType,
  base64: Schema.String.check(Schema.isMaxLength(Math.ceil(PR_IMAGE_LIMIT / 3) * 4)),
  operationId: OperationId,
});

export const Request = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("read"), ...ReadPullRequest.fields }),
  Schema.Struct({ _tag: Schema.Literal("edit"), ...EditPullRequest.fields }),
  Schema.Struct({ _tag: Schema.Literal("comment"), ...CommentPullRequest.fields }),
  Schema.Struct({ _tag: Schema.Literal("reply"), ...ReplyPullRequest.fields }),
  Schema.Struct({ _tag: Schema.Literal("image"), ...UploadPullRequestImage.fields }),
]);
export type Request = typeof Request.Type;

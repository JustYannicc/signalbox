import {
  PullRequestOperationId,
  PullRequestRef,
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
]);
export type Request = typeof Request.Type;

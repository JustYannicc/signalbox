import {
  PULL_REQUEST_REVIEW_TOOL,
  Request,
} from "@signalbox/runner-protocol/PullRequestReviewTools";
import {
  PullRequestCommentUpdateInput,
  PullRequestOperationId,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestReviewHeadSha,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { badArguments, fail, json, register } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

// MCP only accepts one object schema, so validate action-specific requirements with Request below.
const Parameters = Schema.Struct({
  action: Schema.Literals([
    "read",
    "reply",
    "resolve",
    "comment",
    "updateComment",
    "submitReview",
    "setReaction",
  ]),
  number: PullRequestRef.fields.number,
  threadId: Schema.optional(PullRequestThreadReplyInput.fields.threadId),
  body: Schema.optional(PullRequestSubmitReviewInput.fields.body),
  operationId: Schema.optional(PullRequestOperationId),
  resolved: Schema.optional(PullRequestThreadResolutionInput.fields.resolved),
  commentId: Schema.optional(PullRequestCommentUpdateInput.fields.commentId),
  kind: Schema.optional(PullRequestCommentUpdateInput.fields.kind),
  headSha: Schema.optional(PullRequestReviewHeadSha),
  verdict: Schema.optional(PullRequestSubmitReviewInput.fields.verdict),
  comments: Schema.optional(PullRequestSubmitReviewInput.fields.comments),
  subjectId: PullRequestReactionInput.fields.subjectId,
  content: Schema.optional(PullRequestReactionInput.fields.content),
  reacted: Schema.optional(PullRequestReactionInput.fields.reacted),
});
const decodeRequest = Schema.decodeUnknownEffect(Request, { onExcessProperty: "error" });

/** The thread's folder repository, reached through its drive-authenticated cloud client. */
export const layerPullRequestReviewTools = (view: DrivesView) =>
  Layer.effectDiscard(
    register({
      name: PULL_REQUEST_REVIEW_TOOL,
      description:
        'Read a pull request\'s review conversations, including their thread IDs and current headSha. Use action "read" first; replies and resolutions need a threadId from that result. "reply" and "comment" post comments and require an operationId for the exact write; reuse the same operationId when retrying. "updateComment" edits one of your existing conversation or review comments. "submitReview" posts a verdict and optional inline comments against the headSha from the read result; pin it to the reviewed commit so GitHub cannot apply the review to a newer revision, and reuse its operationId if retrying. "setReaction" adds or removes a reaction on the pull request or one comment. Signalbox gets the repository and acting thread from this thread\'s connection, so you only supply the pull request number.',
      parameters: Parameters,
      writes: { destructive: false, openWorld: true },
      handle: (input) =>
        decodeRequest(input).pipe(
          Effect.mapError(badArguments),
          Effect.flatMap((request) =>
            Effect.gen(function* () {
              const client = view.client();
              if (client === null) {
                return yield* fail(
                  "Pull request reviews are available once the thread's first turn starts.",
                );
              }

              const answer = yield* client.automationTool(
                { name: PULL_REQUEST_REVIEW_TOOL, input: request },
                { retry: request.action === "read" },
              );
              if (answer._tag === "failed") {
                return yield* fail(
                  answer.error === undefined ? answer.message : json(answer.error),
                );
              }
              return json(answer.result);
            }),
          ),
        ),
    }),
  );

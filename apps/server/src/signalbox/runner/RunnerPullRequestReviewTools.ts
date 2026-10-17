import {
  PULL_REQUEST_REVIEW_TOOL,
  Request,
} from "@signalbox/runner-protocol/PullRequestReviewTools";
import {
  PullRequestOperationId,
  PullRequestRef,
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
  action: Schema.Literals(["read", "reply", "resolve"]),
  number: PullRequestRef.fields.number,
  threadId: Schema.optional(PullRequestThreadReplyInput.fields.threadId),
  body: Schema.optional(PullRequestThreadReplyInput.fields.body),
  operationId: Schema.optional(PullRequestOperationId),
  resolved: Schema.optional(PullRequestThreadResolutionInput.fields.resolved),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);

/** The thread's folder repository, reached through its drive-authenticated cloud client. */
export const layerPullRequestReviewTools = (view: DrivesView) =>
  Layer.effectDiscard(
    register({
      name: PULL_REQUEST_REVIEW_TOOL,
      description:
        'Read a pull request\'s review conversations, including their thread IDs. Use action "read" first; replies and resolutions need a threadId from that result. "reply" posts a comment and requires an operationId for the exact reply; reuse it if you retry. "resolve" marks a thread resolved or reopens it. Signalbox gets the repository and acting thread from this thread\'s connection, so you only supply the pull request number.',
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

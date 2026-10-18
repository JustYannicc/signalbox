import {
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestInvalidateInput,
  type PullRequestReactionInput,
  type PullRequestSubmitReviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { GitHub } from "./GitHub.ts";
import { makeGitHubCollaborationWrites } from "./GitHubCollaborationWrites.ts";
import { AgentPullRequestError } from "./agentPullRequestError.ts";
import { makeAgentPullRequestReceipts } from "./agentPullRequestReceipts.ts";
import {
  collaborationError,
  makePullRequestWriteAccess,
} from "./pullRequestCollaborationSupport.ts";

const refuse = AgentPullRequestError.forCategory;

/** Comments and reviews have durable receipts; edits and reactions set an existing object's state. */
export const makePullRequestDiscussion = (
  invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const authorize = yield* makePullRequestWriteAccess;
    const receipts = yield* makeAgentPullRequestReceipts(refuse);
    const provider = makeGitHubCollaborationWrites(github.api);

    const create =
      <I extends PullRequestCommentInput | PullRequestSubmitReviewInput>(
        operation: "comment" | "submitReview",
        prepare: (
          target: Effect.Success<ReturnType<typeof authorize>>,
          input: I,
        ) => Effect.Effect<
          Effect.Effect<{ readonly providerId: string }, AgentPullRequestError>,
          AgentPullRequestError
        >,
      ) =>
      (input: I) =>
        Effect.gen(function* () {
          if (!input.operationId) return yield* refuse("invalid");
          const target = yield* authorize(input);
          const threadId = `public-pr:${input.projectId}`;
          const repository = target.repository.toLowerCase();
          const request = {
            ...input,
            operationId: input.operationId,
            operation,
            host: target.host,
            accountId: target.accountId,
          };
          const receipt = yield* receipts.lookup(threadId, repository, request);
          if (receipt._tag === "new") {
            const write = yield* prepare(target, input);
            yield* receipts.run({
              threadId,
              repository,
              operationId: input.operationId,
              request,
              write: () => write,
            });
          }
          yield* invalidate({ reference: input });
        }).pipe(
          Effect.catchTags({
            SqlError: () => Effect.fail(collaborationError(operation)(refuse("unavailable"))),
            AgentPullRequestError: (error) => Effect.fail(collaborationError(operation)(error)),
          }),
        );

    const comment = create("comment", (target, input: PullRequestCommentInput) =>
      input.body.trim().length === 0
        ? Effect.fail(refuse("invalid"))
        : provider.prepareComment(target, input),
    );
    const submitReview = create("submitReview", (target, input: PullRequestSubmitReviewInput) => {
      if (
        !input.headSha ||
        (input.verdict !== "approve" &&
          input.body.trim().length === 0 &&
          input.comments.length === 0) ||
        input.comments.some((comment) => comment.body.trim().length === 0)
      )
        return Effect.fail(refuse("invalid"));
      return provider.prepareReview(target, { ...input, headSha: input.headSha });
    });
    const updateComment = (input: PullRequestCommentUpdateInput) =>
      Effect.gen(function* () {
        if (input.body.trim().length === 0) return yield* refuse("invalid");
        const target = yield* authorize(input);
        yield* provider.updateComment(target, input);
        yield* invalidate({ reference: input });
      }).pipe(
        Effect.catchTags({
          AgentPullRequestError: (error) => Effect.fail(collaborationError("updateComment")(error)),
        }),
      );
    const setReaction = (input: PullRequestReactionInput) =>
      Effect.gen(function* () {
        const target = yield* authorize(input);
        yield* provider.setReaction(target, input);
        yield* invalidate({ reference: input });
      }).pipe(
        Effect.catchTags({
          AgentPullRequestError: (error) => Effect.fail(collaborationError("setReaction")(error)),
        }),
      );
    return { comment, updateComment, submitReview, setReaction };
  });

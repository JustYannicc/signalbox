import {
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestReactionInput,
  type PullRequestSubmitReviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildReviewSubmission,
  gitHubReactionContent,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import type { GitHubApi } from "./GitHubApi.ts";
import { AgentPullRequestError } from "./agentPullRequestError.ts";
import { makeCollaborationQuery } from "./pullRequestCollaborationSupport.ts";
import type { ResolvedPullRequestRepository } from "./PullRequestRepository.ts";

type ProviderId = { readonly providerId: string };
type ProviderWrite = Effect.Effect<ProviderId, AgentPullRequestError>;
type ReviewInput = PullRequestSubmitReviewInput;

const fail = AgentPullRequestError.forCategory;
const repositorySchema = Schema.Struct({ nameWithOwner: Schema.String });
const parentSchema = Schema.Struct({
  __typename: Schema.String,
  id: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  repository: Schema.optional(Schema.NullOr(repositorySchema)),
});
const reactionGroupsSchema = Schema.Array(
  Schema.Struct({ content: Schema.String, viewerHasReacted: Schema.Boolean }),
);

const PullRequestData = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      nameWithOwner: Schema.String,
      pullRequest: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          number: Schema.Number,
          headRefOid: Schema.NullOr(Schema.String),
          viewerCanReact: Schema.Boolean,
          reactionGroups: reactionGroupsSchema,
        }),
      ),
    }),
  ),
});
const CommentLookup = Schema.Struct({
  node: Schema.NullOr(
    Schema.Struct({
      __typename: Schema.String,
      id: Schema.String,
      body: Schema.optional(Schema.String),
      viewerCanUpdate: Schema.optional(Schema.Boolean),
      viewerCanReact: Schema.optional(Schema.Boolean),
      reactionGroups: Schema.optional(reactionGroupsSchema),
      issueCommentPullRequest: Schema.optional(Schema.NullOr(parentSchema)),
      reviewCommentPullRequest: Schema.optional(Schema.NullOr(parentSchema)),
      reviewPullRequest: Schema.optional(Schema.NullOr(parentSchema)),
    }),
  ),
});
type CommentNode = NonNullable<(typeof CommentLookup.Type)["node"]>;
const pullRequestOfComment = (node: CommentNode | null) => {
  if (node === null) return undefined;
  switch (node.__typename) {
    case "IssueComment":
      return node.issueCommentPullRequest;
    case "PullRequestReviewComment":
      return node.reviewCommentPullRequest;
    case "PullRequestReview":
      return node.reviewPullRequest;
    default:
      return undefined;
  }
};

const pullRequestQuery = `query CollaborationPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      id number headRefOid viewerCanReact
      reactionGroups { content viewerHasReacted }
    }
  }
}`;
const commentLookupQuery = `query CollaborationComment($id: ID!) {
  node(id: $id) {
    __typename id
    ... on IssueComment {
      id body viewerCanUpdate viewerCanReact reactionGroups { content viewerHasReacted }
      issueCommentPullRequest: pullRequest { __typename ... on PullRequest { id number repository { nameWithOwner } } }
    }
    ... on PullRequestReviewComment {
      id body viewerCanUpdate viewerCanReact reactionGroups { content viewerHasReacted }
      reviewCommentPullRequest: pullRequest { __typename id number repository { nameWithOwner } }
    }
    ... on PullRequestReview {
      id viewerCanReact reactionGroups { content viewerHasReacted }
      reviewPullRequest: pullRequest { __typename id number repository { nameWithOwner } }
    }
  }
}`;
const addCommentMutation = `mutation CollaborationAddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id } }
    subject { id }
  }
}`;
const updateIssueCommentMutation = `mutation CollaborationUpdateIssueComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id body } }
}`;
const updateReviewCommentMutation = `mutation CollaborationUpdateReviewComment($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id body }
  }
}`;
const addReviewMutation = `mutation CollaborationAddReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview {
      id state commit { oid }
      pullRequest { id number repository { nameWithOwner } }
    }
  }
}`;
const updateCommentResult = Schema.Struct({
  updateIssueComment: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        issueComment: Schema.NullOr(Schema.Struct({ id: Schema.String, body: Schema.String })),
      }),
    ),
  ),
  updatePullRequestReviewComment: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        pullRequestReviewComment: Schema.NullOr(
          Schema.Struct({ id: Schema.String, body: Schema.String }),
        ),
      }),
    ),
  ),
});
const reactionMutationResult = Schema.Struct({
  addReaction: Schema.optional(
    Schema.NullOr(Schema.Struct({ subject: Schema.NullOr(Schema.Struct({ id: Schema.String })) })),
  ),
  removeReaction: Schema.optional(
    Schema.NullOr(Schema.Struct({ subject: Schema.NullOr(Schema.Struct({ id: Schema.String })) })),
  ),
});
const addReactionMutation = `mutation CollaborationAddReaction($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } }
}`;
const removeReactionMutation = `mutation CollaborationRemoveReaction($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } }
}`;

export const makeGitHubCollaborationWrites = (api: GitHubApi) => {
  const query = makeCollaborationQuery(api);

  const ownerAndName = (target: ResolvedPullRequestRepository) => {
    if (target.host.toLowerCase() !== api.host.toLowerCase())
      return Effect.fail(fail("permission", 403));
    const [owner, name, extra] = target.repository.split("/");
    if (!owner || !name || extra !== undefined) return Effect.fail(fail("invalid", 400));
    return Effect.succeed({ owner, name });
  };

  const pullRequest = (target: ResolvedPullRequestRepository, number: number) =>
    Effect.gen(function* () {
      const { owner, name } = yield* ownerAndName(target);
      const data = yield* query(
        target.token,
        pullRequestQuery,
        { owner, name, number },
        PullRequestData,
      );
      const repository = data.repository;
      if (repository === null || repository.pullRequest === null)
        return yield* fail("not_found", 404);
      const pull = repository.pullRequest;
      if (
        repository.nameWithOwner.toLowerCase() !== target.repository.toLowerCase() ||
        pull.number !== number
      )
        return yield* fail("permission", 403);
      return { ...pull, repository: repository.nameWithOwner };
    });

  const commentSubject = (
    target: ResolvedPullRequestRepository,
    input: PullRequestCommentUpdateInput,
  ) =>
    Effect.gen(function* () {
      yield* ownerAndName(target);
      const data = yield* query(
        target.token,
        commentLookupQuery,
        { id: input.commentId },
        CommentLookup,
      );
      const node = data.node;
      const expectedType =
        input.kind === "issue-comment" ? "IssueComment" : "PullRequestReviewComment";
      const parent = pullRequestOfComment(node);
      if (node === null || node.__typename !== expectedType || parent == null)
        return yield* Effect.fail(fail("permission", 403));
      if (
        parent.__typename !== "PullRequest" ||
        parent.number !== input.number ||
        parent.repository?.nameWithOwner.toLowerCase() !== target.repository.toLowerCase()
      )
        return yield* Effect.fail(fail("permission", 403));
      if (node.viewerCanUpdate !== true) return yield* Effect.fail(fail("permission", 403));
      return node;
    });

  const verifyMutationId = (actual: string | null | undefined, expected: string) =>
    actual === expected ? Effect.void : Effect.fail(fail("unavailable", 200));

  const prepareComment = (target: ResolvedPullRequestRepository, input: PullRequestCommentInput) =>
    pullRequest(target, input.number).pipe(
      Effect.map((pull) => {
        const write: ProviderWrite = query(
          target.token,
          addCommentMutation,
          { subjectId: pull.id, body: input.body },
          Schema.Struct({
            addComment: Schema.NullOr(
              Schema.Struct({
                commentEdge: Schema.NullOr(
                  Schema.Struct({ node: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
                ),
                subject: Schema.NullOr(Schema.Struct({ id: Schema.String })),
              }),
            ),
          }),
        ).pipe(
          Effect.flatMap(({ addComment }) => {
            const commentId = addComment?.commentEdge?.node?.id;
            if (commentId === undefined || addComment?.subject?.id !== pull.id)
              return Effect.fail(fail("unavailable", 200));
            return Effect.succeed({ providerId: commentId });
          }),
        );
        return write;
      }),
    );

  const updateComment = (
    target: ResolvedPullRequestRepository,
    input: PullRequestCommentUpdateInput,
  ) =>
    Effect.gen(function* () {
      const node = yield* commentSubject(target, input);
      const body = node.body;
      if (body === undefined) return yield* Effect.fail(fail("unavailable", 200));
      if (body === input.body) return;
      const issueComment = input.kind === "issue-comment";
      const data = yield* query(
        target.token,
        issueComment ? updateIssueCommentMutation : updateReviewCommentMutation,
        { id: input.commentId, body: input.body },
        updateCommentResult,
      );
      const updated = issueComment
        ? data.updateIssueComment?.issueComment
        : data.updatePullRequestReviewComment?.pullRequestReviewComment;
      yield* verifyMutationId(updated?.id, input.commentId);
      if (updated?.body !== input.body) return yield* Effect.fail(fail("unavailable", 200));
    });

  const prepareReview = (target: ResolvedPullRequestRepository, input: ReviewInput) =>
    pullRequest(target, input.number).pipe(
      Effect.flatMap((pull) => {
        if (input.headSha === undefined || input.headSha.trim().length === 0)
          return Effect.fail(fail("invalid", 400));
        if (pull.headRefOid !== input.headSha) return Effect.fail(fail("github_conflict", 409));
        const expectedState =
          input.verdict === "approve"
            ? "APPROVED"
            : input.verdict === "request-changes"
              ? "CHANGES_REQUESTED"
              : "COMMENTED";
        const submission = buildReviewSubmission(input);
        const threads = submission.comments;
        const write: ProviderWrite = query(
          target.token,
          addReviewMutation,
          {
            input: {
              pullRequestId: pull.id,
              commitOID: input.headSha,
              body: submission.body,
              event: submission.event,
              threads,
            },
          },
          Schema.Struct({
            addPullRequestReview: Schema.NullOr(
              Schema.Struct({
                pullRequestReview: Schema.NullOr(
                  Schema.Struct({
                    id: Schema.String,
                    state: Schema.String,
                    commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
                    pullRequest: Schema.NullOr(
                      Schema.Struct({
                        id: Schema.String,
                        number: Schema.Number,
                        repository: repositorySchema,
                      }),
                    ),
                  }),
                ),
              }),
            ),
          }),
        ).pipe(
          Effect.flatMap(({ addPullRequestReview }) => {
            const review = addPullRequestReview?.pullRequestReview;
            if (
              review?.state !== expectedState ||
              review.commit?.oid !== input.headSha ||
              review.pullRequest?.id !== pull.id ||
              review.pullRequest.number !== input.number ||
              review.pullRequest.repository.nameWithOwner.toLowerCase() !==
                target.repository.toLowerCase()
            )
              return Effect.fail(fail("unavailable", 200));
            return Effect.succeed({ providerId: review.id });
          }),
        );
        return Effect.succeed(write);
      }),
    );

  const setReaction = (target: ResolvedPullRequestRepository, input: PullRequestReactionInput) =>
    Effect.gen(function* () {
      const subject =
        input.subjectId === undefined
          ? yield* pullRequest(target, input.number).pipe(
              Effect.map((pull) => ({
                id: pull.id,
                viewerCanReact: pull.viewerCanReact,
                reactionGroups: pull.reactionGroups,
              })),
            )
          : yield* Effect.gen(function* () {
              yield* ownerAndName(target);
              const { node } = yield* query(
                target.token,
                commentLookupQuery,
                { id: input.subjectId },
                CommentLookup,
              );
              const parent = pullRequestOfComment(node);
              if (
                node === null ||
                !(
                  node.__typename === "IssueComment" ||
                  node.__typename === "PullRequestReviewComment" ||
                  node.__typename === "PullRequestReview"
                ) ||
                parent == null ||
                parent.__typename !== "PullRequest" ||
                parent.number !== input.number ||
                parent.repository?.nameWithOwner.toLowerCase() !==
                  target.repository.toLowerCase() ||
                node.viewerCanReact === undefined ||
                node.reactionGroups === undefined
              )
                return yield* fail("permission", 403);
              return {
                id: node.id,
                viewerCanReact: node.viewerCanReact,
                reactionGroups: node.reactionGroups,
              };
            });
      const content = gitHubReactionContent(input.content);
      const reacted = subject.reactionGroups.some(
        (group) => group.content === content && group.viewerHasReacted,
      );
      if (reacted === input.reacted) return;
      if (!subject.viewerCanReact) return yield* Effect.fail(fail("permission", 403));
      const data = yield* query(
        target.token,
        input.reacted ? addReactionMutation : removeReactionMutation,
        { subjectId: subject.id, content },
        reactionMutationResult,
      );
      const mutatedSubject = input.reacted
        ? data.addReaction?.subject
        : data.removeReaction?.subject;
      yield* verifyMutationId(mutatedSubject?.id, subject.id);
    });

  return { prepareComment, updateComment, prepareReview, setReaction };
};

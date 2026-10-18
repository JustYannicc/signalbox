import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestReactionInput,
} from "@t3tools/contracts";
import { scratchProject } from "../environment.ts";
import type { GitHubApi } from "./GitHubApi.ts";
import { makeGitHubCollaborationWrites } from "./GitHubCollaborationWrites.ts";
import type { ResolvedPullRequestRepository } from "./PullRequestRepository.ts";

const head = "a".repeat(40);
const target: ResolvedPullRequestRepository = {
  project: scratchProject,
  repository: "acme/web",
  host: "github.com",
  token: "token",
  viewer: "octocat",
  accountId: "123",
};
const comment: PullRequestCommentInput = {
  projectId: target.project.id,
  repository: target.repository,
  number: 12,
  body: "A note",
};
const commentUpdate: PullRequestCommentUpdateInput = {
  ...comment,
  commentId: "IC_1",
  kind: "issue-comment",
  body: "Edited note",
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = () => {
  const state = {
    repository: "acme/web",
    number: 12,
    head,
    subjectRepository: "acme/web",
    subjectNumber: 12,
    subjectType: "IssueComment",
    canUpdate: true,
    canReact: true,
    body: "Original",
    author: target.viewer,
    reacted: false,
    forbidReview: false,
    calls: [] as Array<{
      readonly document: string;
      readonly variables: Readonly<Record<string, unknown>>;
    }>,
    writes: [] as Array<string>,
  };
  const api = {
    host: "github.com",
    graphql: (
      _operation: string,
      _token: string,
      document: string,
      variables: Readonly<Record<string, unknown>>,
    ) =>
      Effect.sync(() => {
        state.calls.push({ document, variables });
        const parent = {
          __typename: "PullRequest",
          id: "PR_12",
          number: state.subjectNumber,
          repository: { nameWithOwner: state.subjectRepository },
        };
        if (document.includes("query CollaborationPullRequest"))
          return encodeJson({
            data: {
              repository: {
                nameWithOwner: state.repository,
                pullRequest: {
                  id: "PR_12",
                  number: state.number,
                  headRefOid: state.head,
                  viewerCanReact: state.canReact,
                  reactionGroups: state.reacted
                    ? [{ content: "ROCKET", viewerHasReacted: true }]
                    : [],
                },
              },
            },
          });
        if (document.includes("query CollaborationComment"))
          return encodeJson({
            data: {
              node: {
                __typename: state.subjectType,
                id: variables.id,
                body: state.body,
                viewerCanUpdate: state.canUpdate,
                viewerCanReact: state.canReact,
                reactionGroups: state.reacted
                  ? [{ content: "ROCKET", viewerHasReacted: true }]
                  : [],
                ...(state.subjectType === "IssueComment"
                  ? { issueCommentPullRequest: parent }
                  : {}),
                ...(state.subjectType === "PullRequestReviewComment"
                  ? { reviewCommentPullRequest: parent }
                  : {}),
                ...(state.subjectType === "PullRequestReview" ? { reviewPullRequest: parent } : {}),
              },
            },
          });
        if (document.includes("mutation CollaborationAddComment")) {
          state.writes.push("comment");
          return encodeJson({
            data: {
              addComment: { commentEdge: { node: { id: "IC_new" } }, subject: { id: "PR_12" } },
            },
          });
        }
        if (document.includes("mutation CollaborationUpdateIssueComment")) {
          state.writes.push("update-comment");
          state.body = String(variables.body);
          return encodeJson({
            data: { updateIssueComment: { issueComment: { id: variables.id, body: state.body } } },
          });
        }
        if (document.includes("mutation CollaborationUpdateReviewComment")) {
          state.writes.push("update-review-comment");
          state.body = String(variables.body);
          return encodeJson({
            data: {
              updatePullRequestReviewComment: {
                pullRequestReviewComment: { id: variables.id, body: state.body },
              },
            },
          });
        }
        if (document.includes("mutation CollaborationAddReview")) {
          state.writes.push("review");
          const input = variables.input as { commitOID: string; event: string };
          if (state.forbidReview || (input.event === "APPROVE" && state.author === target.viewer))
            return encodeJson({ data: null, errors: [{ type: "FORBIDDEN" }] });
          const reviewState =
            input.event === "APPROVE"
              ? "APPROVED"
              : input.event === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : "COMMENTED";
          return encodeJson({
            data: {
              addPullRequestReview: {
                pullRequestReview: {
                  id: "PRR_new",
                  state: reviewState,
                  commit: { oid: input.commitOID },
                  pullRequest: {
                    id: "PR_12",
                    number: 12,
                    repository: { nameWithOwner: "acme/web" },
                  },
                },
              },
            },
          });
        }
        if (document.includes("mutation CollaborationAddReaction")) {
          state.writes.push("add-reaction");
          state.reacted = true;
          return encodeJson({ data: { addReaction: { subject: { id: variables.subjectId } } } });
        }
        if (document.includes("mutation CollaborationRemoveReaction")) {
          state.writes.push("remove-reaction");
          state.reacted = false;
          return encodeJson({ data: { removeReaction: { subject: { id: variables.subjectId } } } });
        }
        throw new Error(`Unexpected operation: ${document}`);
      }),
  } as unknown as GitHubApi;
  return { state, writes: makeGitHubCollaborationWrites(api) };
};

it.effect(
  "prepares comments after validating the supplied pull request and returns GitHub's id",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const prepared = yield* Effect.result(f.writes.prepareComment(target, comment));
      expect(Result.isSuccess(prepared)).toBe(true);
      if (Result.isFailure(prepared)) return;
      const write = prepared.success;
      expect(f.state.writes).toEqual([]);
      expect(yield* write).toEqual({ providerId: "IC_new" });
      expect(f.state.writes).toEqual(["comment"]);

      f.state.repository = "acme/other";
      const invalid = yield* Effect.result(f.writes.prepareComment(target, comment));
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isSuccess(invalid)) return;
      expect(invalid.failure.category).toBe("permission");
      expect(f.state.writes).toHaveLength(1);
    }),
);

it.effect("updates only a comment on this pull request when GitHub says it is editable", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.subjectRepository = "acme/other";
    expect(yield* f.writes.updateComment(target, commentUpdate).pipe(Effect.flip)).toMatchObject({
      category: "permission",
    });
    f.state.subjectRepository = "acme/web";
    f.state.canUpdate = false;
    expect(yield* f.writes.updateComment(target, commentUpdate).pipe(Effect.flip)).toMatchObject({
      category: "permission",
    });
    f.state.canUpdate = true;
    yield* f.writes.updateComment(target, commentUpdate);
    expect(f.state.writes).toEqual(["update-comment"]);
    const issueCall = f.state.calls.find((call) =>
      call.document.includes("CollaborationUpdateIssueComment"),
    );
    expect(issueCall?.variables).toMatchObject({ id: "IC_1", body: "Edited note" });
    f.state.subjectType = "PullRequestReviewComment";
    yield* f.writes.updateComment(target, {
      ...commentUpdate,
      kind: "review-comment",
      body: "Edited review note",
    });
    expect(f.state.writes).toEqual(["update-comment", "update-review-comment"]);
  }),
);

it.effect("pins review writes to the current head and maps both diff sides to GitHub lines", () =>
  Effect.gen(function* () {
    const f = fixture();
    const review = {
      ...comment,
      verdict: "comment" as const,
      body: "Review summary",
      headSha: "b".repeat(40),
      comments: [
        { path: "added.ts", body: "Added", position: { kind: "added" as const, newLine: 8 } },
        { path: "deleted.ts", body: "Deleted", position: { kind: "deleted" as const, oldLine: 4 } },
        {
          path: "context.ts",
          body: "Old context",
          position: { kind: "context" as const, oldLine: 9, newLine: 10, side: "left" as const },
        },
        {
          path: "context.ts",
          body: "New context",
          position: { kind: "context" as const, oldLine: 9, newLine: 10, side: "right" as const },
        },
      ],
    };
    const stale = yield* Effect.result(f.writes.prepareReview(target, review));
    expect(Result.isFailure(stale)).toBe(true);
    if (Result.isSuccess(stale)) return;
    expect(stale.failure).toMatchObject({ category: "github_conflict", status: 409 });
    expect(f.state.writes).toEqual([]);

    f.state.head = review.headSha;
    const prepared = yield* Effect.result(f.writes.prepareReview(target, review));
    expect(Result.isSuccess(prepared)).toBe(true);
    if (Result.isFailure(prepared)) return;
    const write = prepared.success;
    expect(f.state.writes).toEqual([]);
    expect(yield* write).toEqual({ providerId: "PRR_new" });
    const sent = f.state.calls.at(-1)?.variables.input as {
      commitOID: string;
      event: string;
      threads: ReadonlyArray<Record<string, unknown>>;
    };
    expect(sent).toMatchObject({ commitOID: review.headSha, event: "COMMENT" });
    expect(sent.threads).toEqual([
      { path: "added.ts", body: "Added", line: 8, side: "RIGHT" },
      { path: "deleted.ts", body: "Deleted", line: 4, side: "LEFT" },
      { path: "context.ts", body: "Old context", line: 9, side: "LEFT" },
      { path: "context.ts", body: "New context", line: 10, side: "RIGHT" },
    ]);
  }),
);

it.effect("lets GitHub enforce self-approval rules and reports its refusal", () =>
  Effect.gen(function* () {
    const f = fixture();
    const review = {
      ...comment,
      verdict: "approve" as const,
      body: "",
      headSha: head,
      comments: [],
    };
    const prepared = yield* Effect.result(f.writes.prepareReview(target, review));
    expect(Result.isSuccess(prepared)).toBe(true);
    if (Result.isFailure(prepared)) return;
    const mutation = yield* Effect.result(prepared.success);
    expect(Result.isFailure(mutation)).toBe(true);
    if (Result.isSuccess(mutation)) return;
    expect(mutation.failure).toMatchObject({ category: "permission", status: 403 });
    expect(f.state.writes).toEqual(["review"]);
  }),
);

it.effect("uses the viewer's actual PR reaction for idempotent add and remove", () =>
  Effect.gen(function* () {
    const f = fixture();
    const input: PullRequestReactionInput = { ...comment, content: "rocket", reacted: true };
    yield* f.writes.setReaction(target, input);
    yield* f.writes.setReaction(target, input);
    expect(f.state.writes).toEqual(["add-reaction"]);
    const add = f.state.calls.find((call) => call.document.includes("CollaborationAddReaction"));
    expect(add?.variables).toMatchObject({ subjectId: "PR_12", content: "ROCKET" });
    yield* f.writes.setReaction(target, { ...input, reacted: false });
    expect(f.state.writes).toEqual(["add-reaction", "remove-reaction"]);
  }),
);

it.effect("refuses reactions for comments on another pull request", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.subjectType = "PullRequestReviewComment";
    const input: PullRequestReactionInput = {
      ...comment,
      subjectId: "PRRC_1",
      content: "heart",
      reacted: true,
    };
    f.state.canReact = false;
    expect(yield* f.writes.setReaction(target, input).pipe(Effect.flip)).toMatchObject({
      category: "permission",
    });
    f.state.canReact = true;
    f.state.subjectRepository = "acme/other";
    expect(yield* f.writes.setReaction(target, input).pipe(Effect.flip)).toMatchObject({
      category: "permission",
    });
    expect(f.state.writes).toEqual([]);
  }),
);

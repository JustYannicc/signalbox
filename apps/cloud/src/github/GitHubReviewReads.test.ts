import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { GitHubApi } from "./GitHubApi.ts";
import {
  pullRequestActivity,
  pullRequestDetail,
  pullRequestPreview,
  reviewThreadComments,
} from "./GitHubReviewReads.ts";

interface GraphQlCall {
  readonly operation: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

const mockApi = (answers: Record<string, Array<unknown | null>>) => {
  const calls: GraphQlCall[] = [];
  const api = {
    host: "github.com",
    graphql: (
      operation: string,
      _token: string,
      _query: string,
      variables: Readonly<Record<string, unknown>>,
    ) => {
      calls.push({ operation, variables });
      const answer = answers[operation]?.shift() ?? null;
      return Effect.succeed(answer === null ? null : JSON.stringify(answer));
    },
  } as unknown as GitHubApi;
  return { api, calls };
};

const headSha = "a".repeat(40);

const coreAnswer = () => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 7,
        title: "Detail",
        url: "https://github.com/acme/web/pull/7",
        body: "Body",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        headRefName: "feat/detail",
        baseRefName: "main",
        headRefOid: headSha,
        isCrossRepository: false,
        headRepositoryOwner: null,
        headRepository: null,
        headRef: null,
        author: null,
        autoMergeRequest: null,
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        viewerCanUpdateBranch: false,
        baseRef: null,
        reviewRequests: { nodes: [] },
        labels: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [], pageInfo: { hasNextPage: true } },
                },
              },
            },
          ],
        },
      },
    },
  },
});

const checkContextsAnswer = (sha: string, checkName: string) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: sha,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: checkName,
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        startedAt: "2026-10-02T00:00:00Z",
                        completedAt: "2026-10-02T00:01:00Z",
                        detailsUrl: "https://github.com/check",
                        isRequired: true,
                        checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
});

const activityAnswer = (page: "first" | "last") => {
  const first = page === "first";
  return {
    data: {
      repository: {
        pullRequest: {
          author: first
            ? { __typename: "User", login: "octocat", avatarUrl: "", name: "Octo" }
            : null,
          commits: { nodes: [] },
          comments: {
            pageInfo: { hasNextPage: first, endCursor: first ? "comment-next" : null },
            nodes: [
              {
                id: `comment-${page}`,
                body: `comment ${page}`,
                createdAt: first ? "2026-10-01T00:00:00Z" : "2026-10-03T00:00:00Z",
                lastEditedAt: null,
                url: "https://github.com/acme/web/pull/7#issuecomment",
                author: null,
              },
            ],
          },
          reviews: {
            pageInfo: { hasNextPage: first, endCursor: first ? "review-next" : null },
            nodes: [
              {
                id: `review-${page}`,
                body: `review ${page}`,
                state: "COMMENTED",
                submittedAt: first ? "2026-10-02T00:00:00Z" : "2026-10-04T00:00:00Z",
                lastEditedAt: null,
                url: "https://github.com/acme/web/pull/7#review",
                author: null,
              },
            ],
          },
        },
      },
    },
  };
};

const emptyReviewThreadsAnswer = () => ({
  data: {
    viewer: { login: "octocat" },
    repository: {
      pullRequest: {
        reviewThreads: {
          totalCount: 0,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        author: null,
        reactionGroups: [],
        comments: { nodes: [] },
        reviews: { nodes: [] },
        reviewRequests: { nodes: [] },
        latestReviews: { nodes: [] },
        reviewDismissals: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        commits: { nodes: [] },
      },
    },
  },
});

it.effect("fetches every head check context and refuses a mixed-revision rollup", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestDetail: [coreAnswer()],
      pullRequestDetailChecks: [checkContextsAnswer(headSha, "build")],
    });

    const detail = yield* pullRequestDetail(api, "token", "acme/web", 7);

    expect(detail?.checks.map((check) => check.name)).toEqual(["build"]);
    expect(detail?.checksState).toBe("passing");
    expect(detail?.checksTruncated).toBe(false);
    expect(calls.map((call) => [call.operation, call.variables.after])).toEqual([
      ["pullRequestDetail", undefined],
      ["pullRequestDetailChecks", null],
    ]);

    const { api: changedApi } = mockApi({
      pullRequestDetail: [coreAnswer()],
      pullRequestDetailChecks: [checkContextsAnswer("b".repeat(40), "build")],
    });
    const error = yield* pullRequestDetail(changedApi, "token", "acme/web", 7).pipe(Effect.flip);
    expect(error.operation).toBe("pullRequestDetail");
  }),
);

it.effect("walks issue comments and reviews with their independent cursors", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestActivity: [activityAnswer("first"), activityAnswer("last")],
      pullRequestReviewThreads: [emptyReviewThreadsAnswer()],
    });

    const activity = yield* pullRequestActivity(api, "token", "acme/web", 7);

    expect(activity?.comments.map((comment) => comment.id)).toEqual([
      "comment-first",
      "review-first",
      "comment-last",
      "review-last",
    ]);
    expect(activity?.commentCount).toBe(4);
    const pages = calls.filter((call) => call.operation === "pullRequestActivity");
    expect(
      pages.map(({ variables }) => [
        variables.head,
        variables.commentsAfter,
        variables.reviewsAfter,
      ]),
    ).toEqual([
      [true, null, null],
      [false, "comment-next", "review-next"],
    ]);
  }),
);

it.effect("rejects GraphQL partial data that also contains errors", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestPreview: [
        { data: { repository: null }, errors: [{ message: "permission denied" }] },
      ],
    });

    const error = yield* pullRequestPreview(api, "token", "acme/web", 7).pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestPreview");
  }),
);

it.effect("returns a missing pull request when every GraphQL error is NOT_FOUND", () =>
  Effect.gen(function* () {
    const missingPullRequest = {
      data: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          viewerPermission: "READ",
          pullRequest: null,
        },
      },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }],
    };
    const { api } = mockApi({ pullRequestDetail: [missingPullRequest] });

    expect(yield* pullRequestDetail(api, "token", "acme/web", 7)).toBeNull();
  }),
);

it.effect("rejects a NOT_FOUND result when another GraphQL error is present", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestDetail: [
        {
          data: {
            repository: {
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerPermission: "READ",
              pullRequest: null,
            },
          },
          errors: [
            { type: "NOT_FOUND", message: "Could not resolve to a PullRequest" },
            { type: "FORBIDDEN", message: "Resource not accessible" },
          ],
        },
      ],
    });

    const error = yield* pullRequestDetail(api, "token", "acme/web", 7).pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestDetail");
  }),
);

it.effect("returns one review-thread comment page only for the requested pull request", () =>
  Effect.gen(function* () {
    const threadAnswer = {
      data: {
        viewer: { login: "octocat" },
        repository: { pullRequest: { id: "PR_7" } },
        node: {
          __typename: "PullRequestReviewThread",
          pullRequest: { id: "PR_7" },
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "thread-next" },
            nodes: [
              {
                id: "thread-comment-1",
                author: { __typename: "User", login: "octocat", avatarUrl: "" },
                body: "Please rename this.",
                createdAt: "2026-10-01T00:00:00Z",
                lastEditedAt: null,
                url: "https://github.com/acme/web/pull/7#discussion_r1",
                reactionGroups: [],
              },
            ],
          },
        },
      },
    };
    const { api, calls } = mockApi({ reviewThreadComments: [threadAnswer] });

    const page = yield* reviewThreadComments(api, "token", "acme/web", 7, "THREAD_1", "after-1");

    expect(page.comments.map((comment) => comment.id)).toEqual(["thread-comment-1"]);
    expect(page.nextCursor).toBe("thread-next");
    expect(calls[0]?.variables).toMatchObject({
      number: 7,
      threadId: "THREAD_1",
      after: "after-1",
    });
  }),
);

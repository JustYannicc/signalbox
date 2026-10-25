import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { GitHubApi } from "./GitHubApi.ts";
import { pullRequestActivity } from "./GitHubReviewConversationReads.ts";

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

const activityAnswer = (input: {
  readonly page: number;
  readonly commentsNext: string | null;
  readonly reviewsNext: string | null;
  readonly includeRemark?: boolean;
}) => ({
  data: {
    repository: {
      pullRequest: {
        author: null,
        commits: { nodes: [] },
        comments: {
          pageInfo: {
            hasNextPage: input.commentsNext !== null,
            endCursor: input.commentsNext,
          },
          nodes:
            input.includeRemark === false
              ? []
              : [
                  {
                    id: `comment-${input.page}`,
                    body: `comment ${input.page}`,
                    createdAt: `2026-10-${String(input.page).padStart(2, "0")}T00:00:00Z`,
                    lastEditedAt: null,
                    url: "https://github.com/acme/web/pull/7#issuecomment",
                    author: null,
                  },
                ],
        },
        reviews: {
          pageInfo: {
            hasNextPage: input.reviewsNext !== null,
            endCursor: input.reviewsNext,
          },
          nodes:
            input.includeRemark === false
              ? []
              : [
                  {
                    id: `review-${input.page}`,
                    body: `review ${input.page}`,
                    state: "COMMENTED",
                    submittedAt: `2026-10-${String(input.page).padStart(2, "0")}T01:00:00Z`,
                    lastEditedAt: null,
                    url: "https://github.com/acme/web/pull/7#review",
                    author: null,
                  },
                ],
        },
      },
    },
  },
});

const threadComment = (id: string) => ({
  id,
  author: null,
  body: `thread comment ${id}`,
  createdAt: "2026-10-01T00:00:00Z",
  lastEditedAt: null,
  url: `https://github.com/acme/web/pull/7#${id}`,
  reactionGroups: [],
});

const reviewThread = (page: number, commentCursor: string | null = null) => ({
  id: `thread-${page}`,
  isResolved: false,
  isOutdated: false,
  path: `src/file-${page}.ts`,
  line: 5,
  diffSide: "RIGHT",
  comments: {
    totalCount: commentCursor === null ? 1 : 11,
    pageInfo: {
      hasNextPage: commentCursor !== null,
      endCursor: commentCursor,
    },
    nodes: [threadComment(`thread-comment-${page}`)],
  },
});

const reviewThreadsAnswer = (input: {
  readonly page: number;
  readonly nextCursor?: string | null;
  readonly dismissalCursor?: string | null;
  readonly thread?: boolean;
  readonly threadCommentCursor?: string | null;
}) => ({
  data: {
    viewer: { login: "octocat" },
    repository: {
      pullRequest: {
        reviewThreads: {
          totalCount: input.nextCursor === undefined || input.nextCursor === null ? 1 : 11,
          pageInfo: {
            hasNextPage: input.nextCursor !== undefined && input.nextCursor !== null,
            endCursor: input.nextCursor ?? null,
          },
          nodes:
            input.thread === false ? [] : [reviewThread(input.page, input.threadCommentCursor)],
        },
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        author: null,
        reactionGroups: [],
        comments: { nodes: [] },
        reviews: { nodes: [] },
        reviewRequests: { nodes: [] },
        latestReviews: { nodes: [] },
        reviewDismissals: {
          pageInfo: {
            hasNextPage: input.dismissalCursor !== undefined && input.dismissalCursor !== null,
            endCursor: input.dismissalCursor ?? null,
          },
          nodes: [],
        },
        commits: { nodes: [] },
      },
    },
  },
});

const dismissalAnswer = (input: { readonly page: number; readonly nextCursor: string | null }) => ({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          pageInfo: {
            hasNextPage: input.nextCursor !== null,
            endCursor: input.nextCursor,
          },
          nodes: [
            {
              __typename: "ReviewDismissedEvent",
              dismissalMessage: `dismissal ${input.page}`,
              review: { id: `dismissed-review-${input.page}` },
            },
          ],
        },
      },
    },
  },
});

const completeReviewThreads = () => reviewThreadsAnswer({ page: 1, thread: false });

it.effect(
  "keeps bounded activity pages and advances comment and review cursors independently",
  () =>
    Effect.gen(function* () {
      const answers = Array.from({ length: 10 }, (_, index) => {
        const page = index + 1;
        return activityAnswer({
          page,
          commentsNext: `comments-${page}`,
          reviewsNext: `reviews-${page}`,
        });
      });
      const { api, calls } = mockApi({
        pullRequestActivity: answers,
        pullRequestReviewThreads: [completeReviewThreads()],
      });

      const activity = yield* pullRequestActivity(api, "token", "acme/web", 7);

      expect(activity?.comments).toHaveLength(20);
      expect(activity?.commentsTruncated).toBe(true);
      expect(activity?.reviewThreadsTruncated).toBe(false);
      const pages = calls.filter((call) => call.operation === "pullRequestActivity");
      expect(pages).toHaveLength(10);
      expect(
        pages.map(({ variables }) => [variables.commentsAfter, variables.reviewsAfter]),
      ).toEqual([
        [null, null],
        ...Array.from({ length: 9 }, (_, index) => [
          `comments-${index + 1}`,
          `reviews-${index + 1}`,
        ]),
      ]);
    }),
);

it.effect("returns the first ten review-thread pages and marks the remainder", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestActivity: [
        activityAnswer({ page: 1, commentsNext: null, reviewsNext: null, includeRemark: false }),
      ],
      pullRequestReviewThreads: Array.from({ length: 10 }, (_, index) => {
        const page = index + 1;
        return reviewThreadsAnswer({ page, nextCursor: `thread-${page}` });
      }),
    });

    const activity = yield* pullRequestActivity(api, "token", "acme/web", 7);

    expect(activity?.reviewThreads).toHaveLength(10);
    expect(activity?.reviewThreadsTruncated).toBe(true);
    expect(activity?.commentsTruncated).toBe(false);
    expect(calls.filter((call) => call.operation === "pullRequestReviewThreads")).toHaveLength(10);
  }),
);

it.effect("returns partial dismissal history with the conversation truncation flag", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestActivity: [
        activityAnswer({ page: 1, commentsNext: null, reviewsNext: null, includeRemark: false }),
      ],
      pullRequestReviewThreads: [
        reviewThreadsAnswer({ page: 1, dismissalCursor: "dismissal-1", thread: false }),
      ],
      pullRequestReviewDismissals: Array.from({ length: 10 }, (_, index) => {
        const page = index + 2;
        return dismissalAnswer({ page, nextCursor: `dismissal-${page}` });
      }),
    });

    const activity = yield* pullRequestActivity(api, "token", "acme/web", 7);

    expect(activity?.commentsTruncated).toBe(true);
    expect(activity?.reviewThreadsTruncated).toBe(false);
    expect(calls.filter((call) => call.operation === "pullRequestReviewDismissals")).toHaveLength(
      10,
    );
  }),
);

it.effect("keeps the thread comment cursor visible and reports its omitted tail", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestActivity: [
        activityAnswer({ page: 1, commentsNext: null, reviewsNext: null, includeRemark: false }),
      ],
      pullRequestReviewThreads: [
        reviewThreadsAnswer({ page: 1, thread: true, threadCommentCursor: "thread-comment-next" }),
      ],
    });

    const activity = yield* pullRequestActivity(api, "token", "acme/web", 7);

    expect(activity?.commentsTruncated).toBe(true);
    expect(activity?.reviewThreads?.[0]?.comments).toHaveLength(1);
  }),
);

it.effect("still fails when GitHub returns an error instead of a partial page", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestActivity: [
        { data: { repository: null }, errors: [{ message: "permission denied" }] },
      ],
      pullRequestReviewThreads: [completeReviewThreads()],
    });

    const error = yield* pullRequestActivity(api, "token", "acme/web", 7).pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestActivity");
  }),
);

it.effect("still fails when a review-thread or dismissal continuation is unavailable", () =>
  Effect.gen(function* () {
    const threadApi = mockApi({
      pullRequestActivity: [
        activityAnswer({ page: 1, commentsNext: null, reviewsNext: null, includeRemark: false }),
      ],
      pullRequestReviewThreads: [
        reviewThreadsAnswer({ page: 1, nextCursor: "thread-1", thread: false }),
        { data: { repository: null }, errors: [{ message: "permission denied" }] },
      ],
    });
    const threadError = yield* pullRequestActivity(threadApi.api, "token", "acme/web", 7).pipe(
      Effect.flip,
    );
    expect(threadError.operation).toBe("pullRequestReviewThreads");

    const dismissalApi = mockApi({
      pullRequestActivity: [
        activityAnswer({ page: 1, commentsNext: null, reviewsNext: null, includeRemark: false }),
      ],
      pullRequestReviewThreads: [
        reviewThreadsAnswer({ page: 1, dismissalCursor: "dismissal-1", thread: false }),
      ],
      pullRequestReviewDismissals: [null],
    });
    const dismissalError = yield* pullRequestActivity(
      dismissalApi.api,
      "token",
      "acme/web",
      7,
    ).pipe(Effect.flip);
    expect(dismissalError.operation).toBe("pullRequestReviewThreads");
  }),
);

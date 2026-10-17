import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { GitHubError, type GitHubApi } from "./GitHubApi.ts";
import {
  getGitHubRoutingIdentity,
  listGitHubPullRequestStats,
  listGitHubPullRequests,
} from "./GitHubListingReads.ts";

interface GraphQlCall {
  readonly operation: string;
  readonly token: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

const mockApi = (answers: Array<unknown | null>) => {
  const calls: GraphQlCall[] = [];
  const api = {
    host: "github.com",
    graphql: (
      operation: string,
      token: string,
      query: string,
      variables: Readonly<Record<string, unknown>>,
    ) => {
      const call = { operation, token, query, variables };
      calls.push(call);
      const answer = answers.shift();
      const resolved =
        typeof answer === "function"
          ? (answer as (call: GraphQlCall) => unknown | null)(call)
          : answer;
      return Effect.succeed(resolved === null ? null : JSON.stringify(resolved));
    },
    viewer: (token: string) => {
      expect(token).toBe("user-token");
      return Effect.succeed({ id: 42, login: "octocat" });
    },
  } as unknown as GitHubApi;
  return { api, calls };
};

const row = (number: number) => ({
  author: {
    __typename: "User",
    id: "U_123",
    login: "octocat",
    name: "Octocat",
    avatarUrl: "https://github.com/octocat.png",
  },
  state: "OPEN",
  isDraft: true,
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  latestReviews: { nodes: [] },
  mergedAt: null,
  reviewRequests: { nodes: [] },
  labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  commits: {
    nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
  },
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  headRefName: "fix/button",
  baseRefName: "main",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  additions: 5,
  deletions: 2,
  repository: { nameWithOwner: "acme/web" },
});

const searchAnswer = (
  nodes: ReadonlyArray<unknown>,
  endCursor: string | null = null,
  hasNextPage = false,
) => ({
  data: { search: { pageInfo: { hasNextPage, endCursor }, nodes } },
});

const repositoryAnswer = (
  nodes: ReadonlyArray<unknown>,
  endCursor: string | null = null,
  hasNextPage = false,
) => ({
  data: {
    repository: {
      pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes },
    },
  },
});

const statsAnswer = (call: GraphQlCall, missingNumbers: ReadonlyArray<number> = []) => ({
  data: Object.fromEntries(
    Object.entries(call.variables)
      .filter(([key]) => key.endsWith("_number"))
      .map(([key, value]) => {
        const number = typeof value === "number" ? value : -1;
        return [
          key.replace(/number$/, "repository"),
          {
            pullRequest: missingNumbers.includes(number)
              ? null
              : { additions: number, deletions: 1 },
          },
        ];
      }),
  ),
});

it.effect("uses the upstream search qualifiers and maps line counts and the search cursor", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi([searchAnswer([row(7)], "search-next", true)]);
    const page = yield* listGitHubPullRequests(api, "user-token", {
      repository: "acme/web",
      state: "open",
      involvement: "authored",
      viewer: "octocat",
      limit: 25,
      query: 'fix "button"',
      filters: {
        draft: "only",
        review: "approved",
        checks: "passing",
        author: "me",
        labels: [["bug", "urgent"]],
        excludedLabels: ["wip"],
      },
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      number: 7,
      additions: 5,
      deletions: 2,
      author: { login: "octocat" },
      checksState: "passing",
    });
    expect(page.rawCount).toBe(1);
    expect(page.truncated).toBe(true);
    expect(JSON.parse(page.nextCursor ?? "{}")).toEqual({
      source: "search",
      after: "search-next",
    });
    expect(calls[0]).toMatchObject({
      operation: "listPullRequests",
      token: "user-token",
      variables: {
        q: [
          'is:pr is:open author:octocat "fix \\"button\\""',
          'label:"bug","urgent" -label:"wip" author:"octocat" draft:true',
          "review:approved status:success sort:updated-desc repo:acme/web",
        ].join(" "),
        first: 25,
        after: null,
        stats: true,
      },
    });
  }),
);

it.effect("falls back to the repository list and resumes on that connection", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi([
      searchAnswer([]),
      repositoryAnswer([row(3)], "repository-next", true),
      repositoryAnswer([row(4)]),
    ]);
    const input = {
      repository: "acme/web",
      state: "open" as const,
      involvement: "all" as const,
      viewer: "octocat",
      limit: 1,
    };

    const first = yield* listGitHubPullRequests(api, "user-token", input);
    expect(first.items.map((item) => item.number)).toEqual([3]);
    expect(JSON.parse(first.nextCursor ?? "{}")).toEqual({
      source: "repository",
      after: "repository-next",
    });

    const next = yield* listGitHubPullRequests(api, "user-token", {
      ...input,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(next.items.map((item) => item.number)).toEqual([4]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.variables.after).toBe(null);
    expect(calls[2]?.variables.after).toBe("repository-next");
  }),
);

it.effect("keeps a valid empty search separate from a missing GitHub response", () =>
  Effect.gen(function* () {
    const input = {
      repository: "acme/web",
      state: "open" as const,
      involvement: "all" as const,
      viewer: "octocat",
      limit: 10,
      query: "nothing matches this",
    };
    const empty = mockApi([searchAnswer([])]);
    expect(yield* listGitHubPullRequests(empty.api, "user-token", input)).toMatchObject({
      items: [],
      rawCount: 0,
      truncated: false,
      nextCursor: null,
    });

    const missing = mockApi([null]);
    const error = yield* listGitHubPullRequests(missing.api, "user-token", input).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequests",
      status: 404,
    });
  }),
);

it.effect("treats a missing repository as unavailable while preserving a real empty list", () =>
  Effect.gen(function* () {
    const input = {
      repository: "acme/web",
      state: "open" as const,
      involvement: "all" as const,
      viewer: "octocat",
      limit: 10,
    };
    const missingRepository = mockApi([searchAnswer([]), { data: { repository: null } }]);
    const error = yield* listGitHubPullRequests(missingRepository.api, "user-token", input).pipe(
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequests",
      status: 404,
    });

    const emptyRepository = mockApi([searchAnswer([]), repositoryAnswer([])]);
    expect(yield* listGitHubPullRequests(emptyRepository.api, "user-token", input)).toMatchObject({
      items: [],
      rawCount: 0,
      truncated: false,
      nextCursor: null,
    });
  }),
);

it.effect("batches stats by 25, omits deleted PRs, and reads the routing identity", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi([
      (call: GraphQlCall) => statsAnswer(call, [10]),
      (call: GraphQlCall) => statsAnswer(call),
    ]);
    const stats = yield* listGitHubPullRequestStats(api, "user-token", {
      repository: "acme/web",
      numbers: Array.from({ length: 26 }, (_, index) => index + 1),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      operation: "listPullRequestStats",
      variables: { _0_owner: "acme", _0_name: "web", _0_number: 1, _24_number: 25 },
    });
    expect(calls[1]?.variables).toMatchObject({ _0_number: 26 });
    expect(stats).toHaveLength(25);
    expect(stats[0]).toEqual({
      repository: "acme/web",
      number: 1,
      additions: 1,
      deletions: 1,
    });
    expect(stats.some(({ number }) => number === 10)).toBe(false);
    expect(stats.at(-1)?.number).toBe(26);

    const missingRepository = mockApi([{ data: { _0_repository: null } }]);
    const statsError = yield* listGitHubPullRequestStats(missingRepository.api, "user-token", {
      repository: "acme/web",
      numbers: [9],
    }).pipe(Effect.flip);
    expect(statsError).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequestStats",
      status: 404,
    });

    const deleted = mockApi([{ data: { _0_repository: { pullRequest: null } } }]);
    expect(
      yield* listGitHubPullRequestStats(deleted.api, "user-token", {
        repository: "acme/web",
        numbers: [9],
      }),
    ).toEqual([]);

    expect(yield* getGitHubRoutingIdentity(api, "user-token")).toEqual({
      accountId: "42",
      viewer: "octocat",
    });

    const unavailableApi = {
      ...api,
      viewer: () => Effect.succeed(null),
    } as unknown as GitHubApi;
    const error = yield* getGitHubRoutingIdentity(unavailableApi, "user-token").pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "GitHubError",
      operation: "routeIdentity",
      status: 404,
    });
  }),
);

it.effect("treats partial GraphQL errors as unavailable and preserves rate-limit details", () =>
  Effect.gen(function* () {
    const partial = mockApi([
      {
        data: { _0_repository: null },
        errors: [
          {
            type: "FORBIDDEN",
            message: "Resource not accessible",
            path: ["_0_repository"],
          },
        ],
      },
    ]);
    const input = { repository: "acme/web", numbers: [7] };
    const unavailable = yield* listGitHubPullRequestStats(partial.api, "user-token", input).pipe(
      Effect.flip,
    );
    expect(unavailable).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequestStats",
      status: 200,
    });

    const rateLimit = new GitHubError({
      operation: "listPullRequestStats",
      status: 403,
      message: "GitHub's API rate limit is used up for now.",
      retryAt: 123_456,
    });
    const limitedApi = {
      ...partial.api,
      graphql: () => Effect.fail(rateLimit),
    } as unknown as GitHubApi;
    const limited = yield* listGitHubPullRequestStats(limitedApi, "user-token", input).pipe(
      Effect.flip,
    );
    expect(limited).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequestStats",
      status: 403,
      retryAt: 123_456,
    });
  }),
);

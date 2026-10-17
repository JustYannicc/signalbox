import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { GitHubApi } from "./GitHubApi.ts";
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
      calls.push({ operation, token, query, variables });
      const answer = answers.shift();
      return Effect.succeed(answer === null ? null : JSON.stringify(answer));
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

it.effect("reads list stats and the authenticated routing identity", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi([
      { data: { repository: { pullRequest: { additions: 8, deletions: 3 } } } },
    ]);
    const stats = yield* listGitHubPullRequestStats(api, "user-token", {
      repository: "acme/web",
      numbers: [9],
    });
    expect(stats).toEqual([{ repository: "acme/web", number: 9, additions: 8, deletions: 3 }]);
    expect(calls[0]).toMatchObject({
      operation: "listPullRequestStats",
      variables: { owner: "acme", name: "web", number: 9 },
    });

    const missingRepository = mockApi([{ data: { repository: null } }]);
    const statsError = yield* listGitHubPullRequestStats(missingRepository.api, "user-token", {
      repository: "acme/web",
      numbers: [9],
    }).pipe(Effect.flip);
    expect(statsError).toMatchObject({
      _tag: "GitHubError",
      operation: "listPullRequestStats",
      status: 404,
    });

    const deleted = mockApi([{ data: { repository: { pullRequest: null } } }]);
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

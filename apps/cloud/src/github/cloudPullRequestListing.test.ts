import {
  type OrchestrationProjectShell,
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Environment from "../environment.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubError, type GitHubApi } from "./GitHubApi.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import type { ResolvedPullRequestRepository } from "./PullRequestRepository.ts";
import { makeReadCache } from "./cloudReadCache.ts";
import { makeListingReads } from "./cloudPullRequestListing.ts";

interface GraphQlCall {
  readonly operation: string;
  readonly token: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

const row = (number: number, repository: string) => ({
  author: {
    __typename: "User",
    id: "U_456",
    login: "contributor",
    name: "Contributor",
    avatarUrl: "https://github.com/contributor.png",
  },
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  mergedAt: null,
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "octocat" } }] },
  labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${repository}/pull/${number}`,
  headRefName: "fix/button",
  baseRefName: "main",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  additions: 5,
  deletions: 2,
  repository: { nameWithOwner: repository.toLowerCase() },
});

const searchAnswer = (
  nodes: ReadonlyArray<unknown>,
  endCursor: string | null = null,
  hasNextPage = false,
) => ({ data: { search: { pageInfo: { hasNextPage, endCursor }, nodes } } });

const project = (id: string, title: string, repository: string): OrchestrationProjectShell => ({
  ...Environment.scratchProject,
  id: ProjectId.make(id),
  title,
  repositoryIdentity: {
    canonicalKey: `github.com/${repository.toLowerCase()}`,
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: `https://github.com/${repository}.git`,
    },
    provider: "github" as const,
    displayName: repository,
    owner: repository.split("/")[0]!,
    name: repository.split("/")[1]!,
  },
});

const target = (
  projectShell: OrchestrationProjectShell,
  repository: string,
): ResolvedPullRequestRepository => ({
  project: projectShell,
  repository,
  host: "github.com",
  token: "user-token",
  viewer: "octocat",
  accountId: "42",
});

const fixture = (options: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly targets?: ReadonlyArray<ResolvedPullRequestRepository>;
  readonly answers?: Array<unknown | null>;
  readonly failures?: Array<GitHubError>;
  readonly resolve?: PullRequestRepository.PullRequestRepository["Service"]["resolve"];
  readonly forProject?: PullRequestRepository.PullRequestRepository["Service"]["forProject"];
}) => {
  const answers = [...(options.answers ?? [])];
  const failures = [...(options.failures ?? [])];
  const calls: GraphQlCall[] = [];
  const api = {
    host: "github.com",
    graphql: (
      operation: string,
      token: string,
      _query: string,
      variables: Readonly<Record<string, unknown>>,
    ) => {
      calls.push({ operation, token, variables });
      const failure = failures.shift();
      if (failure !== undefined) return Effect.fail(failure);
      const queued = answers.shift();
      const answer = typeof queued === "function" ? queued(variables) : queued;
      return Effect.succeed(answer == null ? null : JSON.stringify(answer));
    },
  } as unknown as GitHubApi;
  const targets = options.targets ?? options.projects.map((shell) => target(shell, "acme/web"));
  const byProject = new Map(targets.map((entry) => [entry.project.id, entry]));
  const service = PullRequestRepository.PullRequestRepository.of({
    projects: Effect.succeed(options.projects),
    forProject:
      options.forProject ??
      ((id) => {
        const found = byProject.get(id);
        return found === undefined
          ? Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }))
          : Effect.succeed(found);
      }),
    resolve:
      options.resolve ??
      ((ref) => {
        const found = byProject.get(ref.projectId);
        return found === undefined ||
          found.repository.toLowerCase() !== ref.repository.toLowerCase()
          ? Effect.fail(
              new PullRequestOperationError({
                operation: "routeIdentity",
                detail: "The GitHub repository could not be verified.",
              }),
            )
          : Effect.succeed(found);
      }),
    identity: () =>
      Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(GitHub, GitHub.of({ pipes: null, api })),
    Layer.succeed(PullRequestRepository.PullRequestRepository, service),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, GitHub | PullRequestRepository.PullRequestRepository>,
  ) => Effect.provide(effect, layer);
  return { calls, run };
};

it.effect("deduplicates repositories, decorates their rows, and shares the low-level read", () => {
  const first = project("project-one", "First", "Acme/Web");
  const second = project("project-two", "Second", "acme/web");
  const current = fixture({
    projects: [first, second],
    targets: [target(first, "Acme/Web"), target(second, "acme/web")],
    answers: [searchAnswer([row(7, "Acme/Web")], "next", true)],
  });
  const input = { state: "open" as const, query: "button", projectIds: [first.id, second.id] };

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const initial = yield* listing.list(input);
      const cached = yield* listing.list(input);

      expect(current.calls).toHaveLength(1);
      expect(initial.entries).toHaveLength(1);
      expect(initial.entries[0]).toMatchObject({
        provider: "github",
        host: "github.com",
        projectId: first.id,
        projectTitle: "First",
        repository: "Acme/Web",
        number: 7,
        additions: 5,
        deletions: 2,
        viewerReviewRequested: true,
      });
      expect(initial.viewers).toEqual({ "github.com": "octocat" });
      expect(initial.providers).toEqual([
        expect.objectContaining({
          host: "github.com",
          kind: "github",
          searchesOnHost: true,
          projectCount: 1,
          configured: true,
          detail: null,
        }),
      ]);
      expect(cached.entries[0]?.observedAt).toBeDefined();
    }),
  );
});

it.effect(
  "keeps continuation cursors separate per repository and reads only selected repositories",
  () => {
    const first = project("project-a", "A", "acme/a");
    const second = project("project-b", "B", "acme/b");
    const current = fixture({
      projects: [first, second],
      targets: [target(first, "acme/a"), target(second, "acme/b")],
      answers: [
        searchAnswer([row(1, "acme/a")], "a-next", true),
        searchAnswer([row(2, "acme/b")]),
        searchAnswer([row(3, "acme/a")]),
      ],
    });

    return current.run(
      Effect.gen(function* () {
        const listing = yield* makeListingReads(makeReadCache());
        const firstPage = yield* listing.list({ state: "open", query: "fix" });
        const keyA = "github.com acme/a";
        const keyB = "github.com acme/b";
        const envelope = JSON.parse(firstPage.nextCursors[keyA] ?? "{}") as {
          readonly cursor?: string;
          readonly key?: string;
          readonly v?: number;
        };
        expect(envelope).toMatchObject({ key: keyA, v: 1 });
        expect(JSON.parse(envelope.cursor ?? "{}")).toEqual({ source: "search", after: "a-next" });
        expect(firstPage.truncated).toBe(true);

        const nextPage = yield* listing.list({
          state: "open",
          query: "fix",
          cursors: { [keyA]: firstPage.nextCursors[keyA]! },
        });
        expect(nextPage.entries.map((entry) => entry.number)).toEqual([3]);
        expect(current.calls).toHaveLength(3);
        expect(current.calls[2]?.variables.after).toBe("a-next");
        expect(
          current.calls.some((call) => call.variables.q?.toString().endsWith("repo:acme/b")),
        ).toBe(true);
        expect(Object.hasOwn(nextPage.nextCursors, keyB)).toBe(false);
      }),
    );
  },
);

it.effect("rejects a continuation cursor when its query changes before another GitHub read", () => {
  const shell = project("cursor-query", "Cursor query", "acme/web");
  const current = fixture({
    projects: [shell],
    targets: [target(shell, "acme/web")],
    answers: [searchAnswer([row(7, "acme/web")], "next", true)],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const first = yield* listing.list({ state: "open", query: "first query" });
      const failure = yield* Effect.result(
        listing.list({
          state: "open",
          query: "different query",
          cursors: { "github.com acme/web": first.nextCursors["github.com acme/web"]! },
        }),
      );

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(failure.failure._tag).toBe("PullRequestOperationError");
      expect(current.calls).toHaveLength(1);
    }),
  );
});

it.effect("shares stats for a repository while decorating each selected project", () => {
  const first = project("stats-a", "A", "acme/web");
  const second = project("stats-b", "B", "acme/web");
  const statsAnswer = (variables: Readonly<Record<string, unknown>>) => ({
    data: Object.fromEntries(
      Object.keys(variables)
        .filter((key) => key.endsWith("_number"))
        .map((key) => [
          key.replace(/number$/, "repository"),
          { pullRequest: { additions: 12, deletions: 4 } },
        ]),
    ),
  });
  const current = fixture({
    projects: [first, second],
    targets: [target(first, "acme/web"), target(second, "acme/web")],
    answers: [statsAnswer],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.listStats({
        refs: [
          { projectId: first.id, repository: "acme/web", number: 9 },
          { projectId: second.id, repository: "acme/web", number: 9 },
        ],
      });

      expect(current.calls).toHaveLength(1);
      expect(result.stats).toEqual([
        { projectId: first.id, repository: "acme/web", number: 9, additions: 12, deletions: 4 },
        { projectId: second.id, repository: "acme/web", number: 9, additions: 12, deletions: 4 },
      ]);
    }),
  );
});

it.effect("does not read GitHub when repository authorization fails", () => {
  const shell = project("denied", "Denied", "acme/private");
  const current = fixture({
    projects: [shell],
    forProject: () =>
      Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(current.calls).toHaveLength(0);
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([
        { projectId: shell.id, projectTitle: "Denied", message: "acme/private could not be read." },
      ]);
    }),
  );
});

it.effect("returns an empty listing for Scratch when its drive has no remote", () => {
  const current = fixture({
    projects: [Environment.scratchProject],
    forProject: () =>
      Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(result).toMatchObject({ entries: [], errors: [], providers: [], nextCursors: {} });
      expect(current.calls).toHaveLength(0);
    }),
  );
});

it.effect("fails the listing when every selected repository read fails", () => {
  const first = project("rate-limited-a", "A", "acme/a");
  const second = project("rate-limited-b", "B", "acme/b");
  const retryAt = Date.parse("2026-10-17T16:00:00.000Z");
  const rateLimit = (operation: string) =>
    new GitHubError({
      operation,
      status: 403,
      message: "rate limited",
      retryAt,
    });
  const current = fixture({
    projects: [first, second],
    targets: [target(first, "acme/a"), target(second, "acme/b")],
    failures: [rateLimit("listPullRequests"), rateLimit("listPullRequests")],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const failure = yield* Effect.result(listing.list({ state: "open" }));

      expect(current.calls.length).toBeGreaterThan(0);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") {
        expect(failure.failure._tag).toBe("PullRequestOperationError");
        if (failure.failure._tag === "PullRequestOperationError") {
          expect(failure.failure.operation).toBe("list");
          expect(failure.failure.detail).toContain("rate limit");
          expect(failure.failure.detail).toContain("Retry after 2026-10-17T16:00:00");
          expect(failure.failure.cause).toBeInstanceOf(GitHubError);
        }
      }
    }),
  );
});

it.effect("keeps errors when another selected repository read succeeds empty", () => {
  const failed = project("partial-a", "A", "acme/a");
  const succeeded = project("partial-b", "B", "acme/b");
  const current = fixture({
    projects: [failed, succeeded],
    targets: [target(failed, "acme/a"), target(succeeded, "acme/b")],
    answers: [
      searchAnswer([]),
      {
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    ],
    failures: [
      new GitHubError({ operation: "listPullRequests", status: 503, message: "unavailable" }),
    ],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(current.calls).toHaveLength(3);
      expect(result.entries).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("could not be read");
    }),
  );
});

it.effect("returns successful repository rows alongside another repository error", () => {
  const failed = project("partial-rows-a", "A", "acme/a");
  const succeeded = project("partial-rows-b", "B", "acme/b");
  const current = fixture({
    projects: [failed, succeeded],
    targets: [target(failed, "acme/a"), target(succeeded, "acme/b")],
    answers: [searchAnswer([row(4, "acme/b")])],
    failures: [
      new GitHubError({ operation: "listPullRequests", status: 503, message: "unavailable" }),
    ],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(current.calls).toHaveLength(2);
      expect(result.entries.map((entry) => entry.number)).toEqual([4]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("could not be read");
    }),
  );
});

it.effect("keeps a successful empty repository listing as an empty list", () => {
  const shell = project("empty-github", "Empty", "acme/empty");
  const current = fixture({
    projects: [shell],
    targets: [target(shell, "acme/empty")],
    answers: [
      searchAnswer([]),
      {
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    ],
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(current.calls).toHaveLength(2);
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
    }),
  );
});

it.effect("reports a non-GitHub drive provider as unsupported", () => {
  const current = fixture({
    projects: [Environment.scratchProject],
    forProject: () =>
      Effect.fail(
        new PullRequestUnavailableError({
          reason: "provider-unsupported",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ),
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const result = yield* listing.list({ state: "open" });

      expect(result.providers).toEqual([
        expect.objectContaining({
          host: "gitlab",
          kind: "gitlab",
          configured: false,
          searchesOnHost: false,
          detail: "This host cannot be browsed here yet.",
        }),
      ]);
      expect(current.calls).toHaveLength(0);
    }),
  );
});

it.effect("reports a missing GitHub connection instead of an empty listing", () => {
  const shell = project("unconnected", "Unconnected", "acme/web");
  const current = fixture({
    projects: [shell],
    forProject: () =>
      Effect.fail(
        new PullRequestUnavailableError({
          reason: "cli-unauthenticated",
          provider: SourceControlProviderKind.make("github"),
        }),
      ),
  });

  return current.run(
    Effect.gen(function* () {
      const listing = yield* makeListingReads(makeReadCache());
      const failure = yield* Effect.result(listing.list({ state: "open" }));

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(failure.failure._tag).toBe("PullRequestUnavailableError");
      expect(current.calls).toHaveLength(0);
    }),
  );
});

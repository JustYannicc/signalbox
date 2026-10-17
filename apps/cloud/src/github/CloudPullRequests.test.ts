import {
  type OrchestrationV2ThreadShell,
  type PullRequestRef,
  type ThreadPullRequestLink,
  PullRequestUnavailableError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { GitHubPullRequestSummary } from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as Environment from "../environment.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserShell from "../user/UserShell.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubApi } from "./GitHubApi.ts";
import * as Review from "./GitHubReviewReads.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import * as Listing from "./cloudPullRequestListing.ts";
import * as CloudPullRequests from "./CloudPullRequests.ts";

vi.mock("./GitHubReviewReads.ts", () => ({
  pullRequestSummary: vi.fn(),
  pullRequestDetail: vi.fn(),
  pullRequestPreview: vi.fn(),
  pullRequestActivity: vi.fn(),
  pullRequestStack: vi.fn(),
  reviewThreadComments: vi.fn(),
  pullRequestDiff: vi.fn(),
  pullRequestDiffFileContents: vi.fn(),
}));

vi.mock("./cloudPullRequestListing.ts", () => ({
  makeListingReads: vi.fn(),
}));

const projectId = Environment.scratchProject.id;
const reference = (overrides: Partial<PullRequestRef> = {}): PullRequestRef => ({
  projectId,
  repository: "acme/web",
  number: 12,
  ...overrides,
});

const summaryValue = (title: string): GitHubPullRequestSummary => ({
  number: 12,
  title,
  url: "https://github.com/Acme/Web/pull/12",
  state: "open",
  isDraft: false,
  closedAt: null,
  mergedAt: null,
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: "2026-10-17T10:00:00.000Z",
  author: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  reviewDecision: null,
  checksState: null,
  mergeability: "mergeable",
});

const link = (source: ThreadPullRequestLink["source"] = "created"): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/web",
  number: 12,
  url: "https://github.com/acme/web/pull/12",
  source,
  linkedAt: "2026-10-17T10:00:00.000Z",
  snapshot: null,
  stack: null,
});

const now = DateTime.makeUnsafe(Date.parse("2026-10-17T10:00:00.000Z"));
const threadShell = (
  id: string,
  title: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make(id),
  projectId,
  title,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [link()],
  lineage: {
    rootThreadId: ThreadId.make(id),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make(`run-${id}`),
  latestRunStartedAt: now,
  latestRunCompletedAt: null,
  activeRunId: null,
  activityRunStatus: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

const makeFixture = () => {
  const state = {
    userId: "owner",
    token: "token-A",
    accountId: "account-A",
    repository: "Acme/Web",
    authorized: true,
    userIdFailed: false,
    resolveCalls: 0,
    canSeeCalls: [] as Array<{ readonly userId: string; readonly threadId: ThreadId }>,
    syncCalls: [] as Array<{ readonly userId: string; readonly threadId: ThreadId }>,
  };
  const target = (ref: PullRequestRef): PullRequestRepository.ResolvedPullRequestRepository => ({
    project: {
      ...Environment.scratchProject,
      id: ref.projectId,
      title: ref.projectId === projectId ? "Scratch" : "Another project",
    },
    repository: state.repository,
    host: "github.com",
    token: state.token,
    viewer: `viewer-${state.accountId}`,
    accountId: state.accountId,
  });
  const repository = PullRequestRepository.PullRequestRepository.of({
    projects: Effect.succeed([Environment.scratchProject]),
    forProject: (id) => Effect.succeed(target(reference({ projectId: id }))),
    resolve: (ref) => {
      state.resolveCalls += 1;
      return state.authorized
        ? Effect.succeed({ ...target(ref), repository: ref.repository })
        : Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
    },
    identity: (host) =>
      Effect.succeed({
        accountId: state.accountId,
        host,
        provider: "github",
        viewer: `viewer-${state.accountId}`,
      }),
  });
  const shell = Environment.shellSnapshot({
    sequence: 0,
    projects: [Environment.scratchProject],
    threads: [
      threadShell("visible", "Visible active"),
      threadShell("private", "Stale private title"),
      threadShell("dismissed", "Dismissed stack member", {
        pullRequests: [link("stack-dismissed")],
      }),
      threadShell("archived", "Visible archived", { archivedAt: now }),
    ],
  });
  const userShell = UserShell.UserShell.of({
    snapshot: Effect.succeed(shell),
    subscribe: () => Effect.succeed(Stream.empty),
    recordThreadSummary: () => Effect.void,
    rebuildThreadIndex: Effect.succeed(0),
  });
  const userDrives = UserDrives.UserDrives.of({
    userId: Effect.suspend(() =>
      state.userIdFailed
        ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: "unavailable" }) }))
        : Effect.succeed(state.userId),
    ),
    contextIds: Effect.succeed([]),
    drives: Effect.succeed([]),
    changes: Stream.empty,
    changed: Stream.empty,
    access: () => Effect.succeed("owner"),
  });
  const canSee: CloudThreadService["Service"]["canSee"] = (actor, id) =>
    Effect.sync(() => {
      state.canSeeCalls.push({ userId: actor.userId, threadId: id });
      return id !== ThreadId.make("private") || actor.userId === "owner";
    });
  const threadLayer = Layer.mock(CloudThreadService, {
    canSee,
    requestPullRequestSync: (actor, threadId) =>
      Effect.sync(() => {
        state.syncCalls.push({ userId: actor.userId, threadId });
      }),
  });
  const api = { host: "github.com" } as GitHubApi;
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitHub, GitHub.of({ pipes: null, api })),
    Layer.succeed(PullRequestRepository.PullRequestRepository, repository),
    Layer.succeed(UserShell.UserShell, userShell),
    Layer.succeed(UserDrives.UserDrives, userDrives),
    threadLayer,
  );
  return {
    state,
    layer: CloudPullRequests.layer.pipe(Layer.provide(dependencies)),
  };
};

describe("CloudPullRequests", () => {
  beforeEach(() => {
    vi.mocked(Review.pullRequestSummary).mockReset().mockReturnValue(Effect.succeed(null));
    vi.mocked(Review.pullRequestDetail).mockReset().mockReturnValue(Effect.succeed(null));
    vi.mocked(Review.pullRequestPreview).mockReset();
    vi.mocked(Review.pullRequestActivity).mockReset();
    vi.mocked(Review.pullRequestStack).mockReset();
    vi.mocked(Review.reviewThreadComments).mockReset();
    vi.mocked(Review.pullRequestDiff).mockReset();
    vi.mocked(Review.pullRequestDiffFileContents).mockReset();
    vi.mocked(Listing.makeListingReads)
      .mockReset()
      .mockReturnValue(
        Effect.succeed({
          list: () =>
            Effect.succeed({
              viewers: {},
              providers: [],
              entries: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            }),
          listStats: () => Effect.succeed({ stats: [] }),
        }),
      );
  });

  it.effect(
    "filters linked threads through current access and includes visible archived threads",
    () => {
      const fixture = makeFixture();
      return Effect.gen(function* () {
        const pullRequests = yield* CloudPullRequests.CloudPullRequests;
        const ref = reference();

        const ownerView = yield* pullRequests.linkedThreads(ref);
        expect(ownerView.threads.map((thread) => thread.title)).toEqual([
          "Visible active",
          "Stale private title",
          "Visible archived",
        ]);
        expect(
          ownerView.threads.find((thread) => thread.id === ThreadId.make("archived"))?.archivedAt,
        ).toEqual(DateTime.formatIso(now));
        expect(
          fixture.state.canSeeCalls.some((call) => call.threadId === ThreadId.make("dismissed")),
        ).toBe(false);

        fixture.state.userId = "another-user";
        const otherView = yield* pullRequests.linkedThreads(ref);
        expect(otherView.threads.map((thread) => thread.title)).toEqual([
          "Visible active",
          "Visible archived",
        ]);
        expect(
          fixture.state.canSeeCalls.filter((call) => call.threadId === ThreadId.make("private")),
        ).toEqual([
          { userId: "owner", threadId: ThreadId.make("private") },
          { userId: "another-user", threadId: ThreadId.make("private") },
        ]);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "rechecks repository authorization before reusing a summary and isolates credential caches",
    () => {
      const fixture = makeFixture();
      let providerReads = 0;
      vi.mocked(Review.pullRequestSummary).mockImplementation((_api, token) => {
        providerReads += 1;
        return Effect.succeed(summaryValue(`read with ${token}`));
      });

      return Effect.gen(function* () {
        const pullRequests = yield* CloudPullRequests.CloudPullRequests;
        const ref = reference();
        expect((yield* pullRequests.summary(ref)).title).toBe("read with token-A");

        fixture.state.authorized = false;
        const denied = yield* Effect.flip(pullRequests.summary(ref));
        expect(denied._tag).toBe("PullRequestUnavailableError");
        fixture.state.authorized = true;

        expect((yield* pullRequests.summary(ref)).title).toBe("read with token-A");
        expect(fixture.state.resolveCalls).toBe(3);
        expect(providerReads).toBe(1);

        fixture.state.token = "token-B";
        fixture.state.accountId = "account-B";
        expect((yield* pullRequests.summary(ref)).title).toBe("read with token-B");
        expect(fixture.state.resolveCalls).toBe(4);
        expect(providerReads).toBe(2);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "invalidates only the resolved repository's cached reads and publishes a refresh revision",
    () => {
      const fixture = makeFixture();
      let providerReads = 0;
      vi.mocked(Review.pullRequestSummary).mockImplementation((_api, token, repository) => {
        providerReads += 1;
        return Effect.succeed(summaryValue(`${repository} via ${token}`));
      });

      return Effect.gen(function* () {
        const pullRequests = yield* CloudPullRequests.CloudPullRequests;
        const primary = reference();
        const other = reference({
          projectId: ProjectId.make("another-project"),
          repository: "Elsewhere/Repo",
        });

        yield* pullRequests.summary(primary);
        fixture.state.repository = "Elsewhere/Repo";
        yield* pullRequests.summary(other);
        fixture.state.repository = "Acme/Web";
        yield* pullRequests.summary(primary);
        expect(providerReads).toBe(2);

        const refresh = yield* Effect.forkChild(Stream.runHead(pullRequests.subscribeRefreshes));
        yield* Effect.yieldNow;
        yield* pullRequests.invalidate({ reference: primary });
        yield* pullRequests.summary(primary);
        expect(providerReads).toBe(3);

        fixture.state.repository = "Elsewhere/Repo";
        yield* pullRequests.summary(other);
        expect(providerReads).toBe(3);

        expect(Option.getOrNull(yield* Fiber.join(refresh))).toBe(1);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("reports missing summary and detail data as provider errors", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const pullRequests = yield* CloudPullRequests.CloudPullRequests;
      const summaryError = yield* Effect.flip(pullRequests.summary(reference()));
      expect(summaryError._tag).toBe("PullRequestOperationError");
      if (summaryError._tag === "PullRequestOperationError")
        expect(summaryError.operation).toBe("summary");

      const detailError = yield* Effect.flip(pullRequests.detail(reference()));
      expect(detailError._tag).toBe("PullRequestOperationError");
      if (detailError._tag === "PullRequestOperationError")
        expect(detailError.operation).toBe("detail");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refreshes only visible linked threads and tolerates a removed repository", () => {
    const fixture = makeFixture();
    fixture.state.userId = "another-user";
    return Effect.gen(function* () {
      const pullRequests = yield* CloudPullRequests.CloudPullRequests;
      yield* pullRequests.invalidate({ reference: reference() });
      expect(fixture.state.syncCalls.map((call) => call.threadId)).toEqual([
        ThreadId.make("visible"),
        ThreadId.make("archived"),
      ]);
      fixture.state.authorized = false;
      yield* pullRequests.invalidate({ reference: reference() });
      expect(fixture.state.syncCalls).toHaveLength(2);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("resolves another repository's URL through the folder's current GitHub account", () => {
    const fixture = makeFixture();
    vi.mocked(Review.pullRequestSummary).mockReturnValue(Effect.succeed(summaryValue("Upstream")));
    return Effect.gen(function* () {
      const pullRequests = yield* CloudPullRequests.CloudPullRequests;
      const value = yield* pullRequests.resolvePullRequest({
        cwd: Environment.scratchProject.workspaceRoot,
        reference: "https://github.com/elsewhere/repo/pull/12",
      });
      expect(value.pullRequest.title).toBe("Upstream");
      expect(Review.pullRequestSummary).toHaveBeenCalledWith(
        expect.anything(),
        "token-A",
        "elsewhere/repo",
        12,
      );
      const wrongHost = yield* pullRequests
        .resolvePullRequest({
          cwd: Environment.scratchProject.workspaceRoot,
          reference: "https://gitlab.com/elsewhere/repo/-/merge_requests/12",
        })
        .pipe(Effect.flip);
      expect(wrongHost._tag).toBe("GitManagerError");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("returns a typed resolution error when the current user cannot be read", () => {
    const fixture = makeFixture();
    fixture.state.userIdFailed = true;
    return Effect.gen(function* () {
      const pullRequests = yield* CloudPullRequests.CloudPullRequests;
      const error = yield* pullRequests
        .resolvePullRequest({ cwd: Environment.scratchProject.workspaceRoot, reference: "12" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitManagerError");
      expect(error.cause).toBeInstanceOf(SqlError);
    }).pipe(Effect.provide(fixture.layer));
  });
});

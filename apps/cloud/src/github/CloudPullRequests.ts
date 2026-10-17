import {
  GitManagerError,
  PullRequestOperationError,
  SourceControlProviderKind,
  type GitPullRequestRefInput,
  type PullRequestCapabilities,
  type PullRequestDetail,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffInput,
  type PullRequestInvalidateInput,
  type PullRequestRef,
  type PullRequestThreadCommentsInput,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { driveOfRoot, projectOfDrive, threadWorktreeAt } from "../user/contextProjects.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { UserShell } from "../user/UserShell.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubError } from "./GitHubApi.ts";
import * as Review from "./GitHubReviewReads.ts";
import { CloudPullRequests } from "./CloudPullRequestsService.ts";
import {
  PullRequestRepository,
  type ResolvedPullRequestRepository,
} from "./PullRequestRepository.ts";
import { makeListingReads } from "./cloudPullRequestListing.ts";
import { makeReadCache } from "./cloudReadCache.ts";

export { CloudPullRequests };

const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [],
  mergeMethods: [],
  search: true,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  stacks: true,
};
const provider = SourceControlProviderKind.make("github");
const scopeOf = (target: ResolvedPullRequestRepository) =>
  `${target.host}/${target.repository.toLowerCase()}`;
const missing = (operation: string) =>
  new PullRequestOperationError({
    operation,
    detail: "GitHub did not provide this pull request's data.",
    reason: "not-found",
  });
const requireData = <A>(operation: string, value: A | null) =>
  value === null ? Effect.fail(missing(operation)) : Effect.succeed(value);
const failed = (operation: string) => (error: GitHubError) =>
  new PullRequestOperationError({
    operation,
    cause: error,
    detail:
      error.retryAt === undefined
        ? "GitHub could not provide complete pull request data. Try again."
        : `GitHub's rate limit is reached. Retry after ${DateTime.formatIso(DateTime.makeUnsafe(error.retryAt))}.`,
  });

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const repositories = yield* PullRequestRepository;
  const shell = yield* UserShell;
  const threads = yield* CloudThreadService;
  const drives = yield* UserDrives;
  const cache = makeReadCache();
  const listings = yield* makeListingReads(cache);
  const revision = yield* SubscriptionRef.make(0);

  const cachedRead = <I extends PullRequestRef, A>(
    operation: string,
    read: (input: I, target: ResolvedPullRequestRepository) => Effect.Effect<A, GitHubError>,
    ttl = 15_000,
  ) => {
    const cached = cache.memoize(
      ({ input, target }: { readonly input: I; readonly target: ResolvedPullRequestRepository }) =>
        read(input, target),
      ({ input, target }) => ({
        key: JSON.stringify([
          target.token,
          target.project.id,
          target.host,
          target.repository,
          input,
        ]),
        scope: scopeOf(target),
        token: target.token,
      }),
      ttl,
    );
    return (input: I, resolved?: ResolvedPullRequestRepository) =>
      (resolved === undefined ? repositories.resolve(input) : Effect.succeed(resolved)).pipe(
        Effect.flatMap((target) =>
          cached({ input, target }).pipe(Effect.mapError(failed(operation))),
        ),
      );
  };

  const readCore = cachedRead("detail", (ref: PullRequestRef, target) =>
    Review.pullRequestDetail(github.api, target.token, target.repository, ref.number).pipe(
      Effect.flatMap((value) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((observedAt) => (value === null ? null : { ...value, observedAt })),
        ),
      ),
    ),
  );
  const summaryRead = cachedRead("summary", (ref: PullRequestRef, target) =>
    Review.pullRequestSummary(github.api, target.token, target.repository, ref.number).pipe(
      Effect.flatMap((value) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((observedAt) =>
            value === null
              ? null
              : {
                  ...value,
                  provider,
                  projectId: target.project.id,
                  repository: target.repository,
                  observedAt,
                },
          ),
        ),
      ),
    ),
  );
  const summary = (input: PullRequestRef) =>
    summaryRead(input).pipe(Effect.flatMap((value) => requireData("summary", value)));
  const detail = (input: PullRequestRef) =>
    Effect.gen(function* () {
      const target = yield* repositories.resolve(input);
      const core = yield* readCore(input, target).pipe(
        Effect.flatMap((value) => requireData("detail", value)),
      );
      return {
        ...core,
        headSha: core.headSha ?? undefined,
        provider,
        capabilities,
        projectId: target.project.id,
        projectTitle: target.project.title,
        workspaceRoot: target.project.workspaceRoot,
        repository: target.repository,
        observedAt: core.observedAt,
        viewer: target.viewer,
        reviewers: [
          ...core.reviewRequestLogins.map((login) => ({ login, name: null, avatarUrl: null })),
          ...core.reviewRequestTeams,
        ],
        mergeCapabilities: core.viewerAccess.mergeCapabilities,
        viewerPermissions: {
          actions: [],
          comment: false,
          resolve: false,
          verdicts: [],
          requestReviewers: false,
        },
        baseComparison:
          core.comparison?.behindBy == null
            ? "unknown"
            : core.comparison.behindBy > 0
              ? "behind"
              : "up-to-date",
        ...(core.comparison?.behindBy == null ? {} : { behindBy: core.comparison.behindBy }),
      } satisfies PullRequestDetail;
    });
  const checks = (input: PullRequestRef) =>
    readCore(input).pipe(
      Effect.flatMap((value) => requireData("checks", value)),
      Effect.map((value) => ({ state: value.state, checks: value.checks })),
    );
  const previewRead = cachedRead("preview", (ref: PullRequestRef, target) =>
    Review.pullRequestPreview(github.api, target.token, target.repository, ref.number),
  );
  const preview = (input: PullRequestRef) =>
    previewRead(input).pipe(
      Effect.flatMap((value) => requireData("preview", value)),
      Effect.map((value) => ({
        ...value,
        projectId: input.projectId,
        repository: input.repository,
      })),
    );
  const activityRead = cachedRead("activity", (ref: PullRequestRef, target) =>
    Review.pullRequestActivity(github.api, target.token, target.repository, ref.number),
  );
  const activity = (input: PullRequestRef) =>
    activityRead(input).pipe(Effect.flatMap((value) => requireData("activity", value)));
  const stack = cachedRead("stack", (ref: PullRequestRef, target) =>
    Review.pullRequestStack(github.api, target.token, target.repository, ref.number, true),
  );
  const threadComments = cachedRead(
    "threadComments",
    (ref: PullRequestThreadCommentsInput, target) =>
      Review.reviewThreadComments(
        github.api,
        target.token,
        target.repository,
        ref.number,
        ref.threadId,
        ref.cursor,
      ),
  );
  const diffRead = cachedRead("diff", (ref: PullRequestDiffInput, target) =>
    Review.pullRequestDiff(github.api, target.token, target.repository, ref.number, ref),
  );
  const diff = (input: PullRequestDiffInput) =>
    diffRead(input).pipe(Effect.flatMap((value) => requireData("diff", value)));
  const contentsRead = cachedRead(
    "diffFileContents",
    (ref: PullRequestDiffFileContentsInput, target) =>
      Review.pullRequestDiffFileContents(
        github.api,
        target.token,
        target.repository,
        ref.number,
        ref,
      ),
  );
  const diffFileContents = (input: PullRequestDiffFileContentsInput) =>
    contentsRead(input).pipe(Effect.flatMap((value) => requireData("diffFileContents", value)));
  const routing = (input: PullRequestRef) =>
    repositories.resolve(input).pipe(
      Effect.map((target) => ({
        accountId: target.accountId,
        host: target.host,
        provider,
        viewer: target.viewer,
        projectTitle: target.project.title,
        workspaceRoot: target.project.workspaceRoot,
      })),
    );

  const linkedThreads = (input: PullRequestRef) =>
    Effect.gen(function* () {
      const target = yield* repositories.resolve(input);
      const snapshot = yield* shell.snapshot.pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "linkedThreads",
              detail: "Could not load linked threads.",
              cause,
            }),
        ),
      );
      const context = yield* Effect.all({
        userId: drives.userId,
        contextIds: drives.contextIds,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestOperationError({
              operation: "linkedThreads",
              detail: "Could not verify linked thread access.",
              cause,
            }),
        ),
      );
      const { userId, contextIds } = context;
      if (userId === null) return { threads: [] };
      const matching = [...snapshot.threads, ...snapshot.archivedThreads].filter((thread) =>
        thread.pullRequests === undefined
          ? thread.linkedPullRequest != null &&
            threadPullRequestKeysEqual(legacyThreadPullRequestKey(thread.linkedPullRequest), {
              ...input,
              host: target.host,
              repository: target.repository,
            })
          : visibleThreadPullRequests(thread.pullRequests).some((link) =>
              threadPullRequestKeysEqual(link, {
                ...input,
                host: target.host,
                repository: target.repository,
              }),
            ),
      );
      const visible = yield* Effect.filter(
        matching,
        (thread) => threads.canSee({ userId, contextIds }, thread.id),
        { concurrency: 2 },
      );
      return {
        threads: visible.map(({ id, projectId, title, archivedAt }) => ({
          id,
          projectId,
          title,
          archivedAt: archivedAt === null ? null : DateTime.formatIso(archivedAt),
        })),
      };
    });

  const invalidate = (input: PullRequestInvalidateInput) =>
    Effect.gen(function* () {
      const reference = input.reference;
      const target =
        reference === undefined
          ? null
          : yield* repositories.resolve(reference).pipe(Effect.orElseSucceed(() => null));
      const scope = target === null ? undefined : scopeOf(target);
      yield* cache.invalidate(scope);
      yield* SubscriptionRef.update(revision, (current) => current + 1);
      if (reference === undefined || target === null) return;
      const actor = yield* Effect.all({
        userId: drives.userId,
        contextIds: drives.contextIds,
      }).pipe(Effect.orElseSucceed(() => null));
      if (actor === null || actor.userId === null) return;
      const { userId, contextIds } = actor;
      const visible = yield* linkedThreads(reference).pipe(
        Effect.orElseSucceed(() => ({ threads: [] })),
      );
      yield* Effect.forEach(
        visible.threads,
        (thread) =>
          threads
            .requestPullRequestSync(
              { userId, contextIds },
              thread.id,
              threadPullRequestKeyOf({
                host: target.host,
                repository: target.repository,
                number: reference.number,
              }),
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
        { concurrency: 2, discard: true },
      );
    });
  const resolvePullRequest = (input: GitPullRequestRefInput) =>
    Effect.gen(function* () {
      const userId = yield* drives.userId;
      const driveId =
        threadWorktreeAt(input.cwd)?.driveId ??
        (userId === null ? null : driveOfRoot(input.cwd, userId));
      const projectId =
        driveId === null || userId === null ? null : projectOfDrive(driveId, userId);
      if (projectId === null) return yield* missing("resolvePullRequest");
      const target = yield* repositories.forProject(projectId);
      const parsed = parseChangeRequestUrl(input.reference);
      const number =
        parsed?.number ??
        (/^#?[1-9]\d*$/.test(input.reference) ? Number(input.reference.replace(/^#/, "")) : NaN);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (parsed !== null && parsed.host !== target.host)
      )
        return yield* missing("resolvePullRequest");
      const value = yield* summary({
        projectId,
        host: target.host,
        repository: parsed?.repository ?? target.repository,
        number,
      });
      return {
        pullRequest: {
          number: value.number,
          title: value.title,
          url: value.url,
          baseBranch: value.baseBranch,
          headBranch: value.headBranch,
          state: value.state,
        },
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "resolvePullRequest",
            cwd: input.cwd,
            detail: "Could not resolve this pull request through the folder's GitHub connection.",
            cause,
          }),
      ),
    );

  return {
    ...listings,
    summary,
    detail,
    preview,
    checks,
    activity,
    stack,
    linkedThreads,
    threadComments,
    diff,
    diffFileContents,
    routing,
    routingIdentity: ({ host }: { readonly host: string }) => repositories.identity(host),
    invalidate,
    subscribeRefreshes: SubscriptionRef.changes(revision).pipe(Stream.filter((value) => value > 0)),
    resolvePullRequest,
  };
});

export const layer = Layer.effect(CloudPullRequests, make);

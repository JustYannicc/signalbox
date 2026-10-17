import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  pullRequestHostOf,
  type PullRequestDiffStat,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestProviderSummary,
  type PullRequestRef,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { GitHub } from "./GitHub.ts";
import { GitHubError } from "./GitHubApi.ts";
import * as GitHubListingReads from "./GitHubListingReads.ts";
import type { makeReadCache } from "./cloudReadCache.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import type { ResolvedPullRequestRepository } from "./PullRequestRepository.ts";

const REPOSITORY_CONCURRENCY = 2;
const LIST_CACHE_TTL = 15_000;
const STATS_CACHE_TTL = 60_000;
const MAX_CURSOR_LENGTH = 4_096;
const GITHUB_PROVIDER = SourceControlProviderKind.make("github");

type ListingError = PullRequestUnavailableError | PullRequestOperationError;
type ReadCache = ReturnType<typeof makeReadCache>;

const cursorKey = (host: string, repository: string) => `${host} ${repository.toLowerCase()}`;

const cursorFingerprint = (
  target: ResolvedPullRequestRepository,
  input: Pick<PullRequestListInput, "state" | "involvement" | "query" | "filters">,
) => {
  const value = JSON.stringify([
    target.host,
    target.repository.toLowerCase(),
    input.state,
    input.involvement ?? "all",
    input.query ?? null,
    input.filters ?? null,
    target.viewer.toLowerCase(),
  ]);
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
};

const wrapCursor = (
  cursor: string,
  key: string,
  target: ResolvedPullRequestRepository,
  input: Pick<PullRequestListInput, "state" | "involvement" | "query" | "filters">,
) => JSON.stringify({ v: 1, key, fingerprint: cursorFingerprint(target, input), cursor });

const unwrapCursor = (
  value: string,
  key: string,
  target: ResolvedPullRequestRepository,
  input: Pick<PullRequestListInput, "state" | "involvement" | "query" | "filters">,
): string | null => {
  if (value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("v" in parsed) ||
      parsed.v !== 1 ||
      !("key" in parsed) ||
      parsed.key !== key ||
      !("fingerprint" in parsed) ||
      parsed.fingerprint !== cursorFingerprint(target, input) ||
      !("cursor" in parsed) ||
      typeof parsed.cursor !== "string" ||
      parsed.cursor.length === 0
    ) {
      return null;
    }
    return parsed.cursor;
  } catch {
    return null;
  }
};

const githubReadError = (operation: string) => (cause: GitHubError) =>
  new PullRequestOperationError({
    operation,
    cause,
    detail:
      cause.retryAt === undefined
        ? "GitHub could not provide pull request data. Try again."
        : `GitHub's rate limit is reached. Retry after ${DateTime.formatIso(DateTime.makeUnsafe(cause.retryAt))}.`,
  });

const providerIdentity = (project: OrchestrationProjectShell) => {
  const identity = project.repositoryIdentity;
  if (identity === undefined || identity === null) return null;
  const repository = sourceControlRepositorySelector(identity);
  if (repository === null) return null;
  const kind = SourceControlProviderKind.make(
    identity.provider !== undefined && /^[a-z][a-z0-9-]{0,63}$/.test(identity.provider)
      ? identity.provider.toLowerCase()
      : "unknown",
  );
  return {
    kind,
    repository,
    host: pullRequestHostOf(identity, kind),
  };
};

const matchesProjectSelectors = (project: OrchestrationProjectShell, input: PullRequestListInput) =>
  (input.projectId === undefined || project.id === input.projectId) &&
  (input.projectIds === undefined || input.projectIds.includes(project.id));

const statsScope = (target: ResolvedPullRequestRepository) =>
  `${target.host}/${target.repository.toLowerCase()}`;

export const makeListingReads = (cache: ReadCache) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repositories = yield* PullRequestRepository.PullRequestRepository;

    const cachedList = cache.memoize(
      ({
        target,
        input,
      }: {
        readonly target: ResolvedPullRequestRepository;
        readonly input: Parameters<typeof GitHubListingReads.listGitHubPullRequests>[2];
      }) =>
        Effect.flatMap(Clock.currentTimeMillis, (observedAt) =>
          GitHubListingReads.listGitHubPullRequests(github.api, target.token, input).pipe(
            Effect.map((page) => ({ page, observedAt })),
          ),
        ),
      ({ target, input }) => ({
        key: JSON.stringify([
          target.token,
          target.host,
          target.repository.toLowerCase(),
          input.state,
          input.involvement,
          input.viewer.toLowerCase(),
          input.limit,
          input.query ?? null,
          input.filters ?? null,
          input.cursor ?? null,
        ]),
        scope: statsScope(target),
        token: target.token,
      }),
      LIST_CACHE_TTL,
    );

    const cachedStats = cache.memoize(
      ({
        target,
        numbers,
      }: {
        readonly target: ResolvedPullRequestRepository;
        readonly numbers: ReadonlyArray<number>;
      }) =>
        GitHubListingReads.listGitHubPullRequestStats(github.api, target.token, {
          repository: target.repository,
          numbers,
        }),
      ({ target, numbers }) => ({
        key: JSON.stringify([
          target.token,
          target.host,
          target.repository.toLowerCase(),
          [...new Set(numbers)].toSorted((left, right) => left - right),
        ]),
        scope: statsScope(target),
        token: target.token,
      }),
      STATS_CACHE_TTL,
    );

    const list: (
      input: PullRequestListInput,
    ) => Effect.Effect<PullRequestListResult, ListingError> = (input) =>
      Effect.gen(function* () {
        const shellProjects = yield* repositories.projects;
        const selected = shellProjects.filter((project) => matchesProjectSelectors(project, input));

        const resolved = yield* Effect.forEach(
          selected,
          (project) =>
            repositories.forProject(project.id).pipe(
              Effect.result,
              Effect.map((result) => ({ project, result })),
            ),
          { concurrency: REPOSITORY_CONCURRENCY },
        );

        const candidates = new Map<
          string,
          {
            readonly kind: SourceControlProviderKind;
            readonly host: string;
            readonly repository: string;
            readonly projectCount: number;
            readonly configured: boolean;
            readonly detail: string | null;
          }
        >();
        const candidateProjects = new Map<string, Set<string>>();
        const errors: PullRequestListProjectError[] = [];
        const viewers: Record<string, string> = {};
        const unique = new Map<string, ResolvedPullRequestRepository>();
        const failures: Array<ListingError> = [];

        const noteCandidate = (
          kind: SourceControlProviderKind,
          host: string,
          repository: string,
          detail: string | null,
        ) => {
          const normalizedHost = host.toLowerCase();
          if (input.host !== undefined && normalizedHost !== input.host.toLowerCase()) return;
          const groupKey = `${kind} ${normalizedHost}`;
          const repos = candidateProjects.get(groupKey) ?? new Set<string>();
          repos.add(repository.toLowerCase());
          candidateProjects.set(groupKey, repos);
          const current = candidates.get(groupKey);
          candidates.set(groupKey, {
            kind,
            host: normalizedHost,
            repository,
            projectCount: repos.size,
            configured: current?.configured === true,
            detail: current?.configured === true ? null : (detail ?? current?.detail ?? null),
          });
        };

        for (const { project, result } of resolved) {
          const inferred = providerIdentity(project);
          if (Result.isSuccess(result)) {
            const target = result.success;
            if (input.host !== undefined && target.host !== input.host.toLowerCase()) continue;
            noteCandidate(GITHUB_PROVIDER, target.host, target.repository, null);
            const key = cursorKey(target.host, target.repository);
            if (!unique.has(key)) unique.set(key, target);
            viewers[target.host] = target.viewer;
            continue;
          }

          const cause = result.failure;
          if (inferred !== null) {
            noteCandidate(inferred.kind, inferred.host, inferred.repository, cause.message);
          }
          if (
            cause._tag === "PullRequestUnavailableError" &&
            cause.reason === "provider-unsupported"
          ) {
            if (inferred?.kind === GITHUB_PROVIDER) {
              errors.push({
                projectId: project.id,
                projectTitle: project.title,
                message: `${inferred.repository} could not be read.`,
              });
            } else if (cause.provider !== undefined) {
              noteCandidate(
                cause.provider,
                cause.provider,
                project.id,
                "This host cannot be browsed here yet.",
              );
            }
            continue;
          }
          failures.push(cause);
          errors.push({
            projectId: project.id,
            projectTitle: project.title,
            message: `${inferred?.repository ?? project.title} could not be read.`,
          });
        }

        // A missing credential or repository service is a real failure, never an empty list.
        if (unique.size === 0 && failures.length > 0) return yield* failures[0]!;
        for (const [groupKey, candidate] of candidates) {
          if (
            candidate.kind === GITHUB_PROVIDER &&
            [...unique.values()].some((target) => target.host === candidate.host)
          ) {
            candidates.set(groupKey, { ...candidate, configured: true, detail: null });
          }
        }

        const providers: PullRequestProviderSummary[] = [...candidates.values()].map(
          (candidate) => ({
            host: candidate.host,
            kind: candidate.kind,
            searchesOnHost: candidate.kind === GITHUB_PROVIDER,
            actions: [],
            projectCount: Math.max(candidate.projectCount, 1),
            configured: candidate.configured,
            detail: candidate.detail,
          }),
        );

        const continuation = input.cursors;
        const selectedRepos = [...unique].filter(
          ([key]) => continuation === undefined || Object.hasOwn(continuation, key),
        );
        const nativeCursors = new Map<string, string | undefined>();
        for (const [key, target] of selectedRepos) {
          const value = continuation?.[key];
          if (value === undefined) {
            nativeCursors.set(key, undefined);
            continue;
          }
          const cursor = unwrapCursor(value, key, target, input);
          if (cursor === null) {
            return yield* new PullRequestOperationError({
              operation: "list",
              detail: "The pull request list could not be continued.",
            });
          }
          nativeCursors.set(key, cursor);
        }
        const batches = yield* Effect.forEach(
          selectedRepos,
          ([key, target]) => {
            const listInput = {
              repository: target.repository,
              state: input.state,
              involvement: input.involvement ?? "all",
              viewer: target.viewer,
              limit: input.limit ?? 99,
              ...(input.query === undefined ? {} : { query: input.query }),
              ...(input.filters === undefined ? {} : { filters: input.filters }),
              ...(nativeCursors.get(key) === undefined ? {} : { cursor: nativeCursors.get(key)! }),
            };
            return cachedList({ target, input: listInput }).pipe(
              Effect.result,
              Effect.map((read) => {
                if (Result.isFailure(read)) {
                  return {
                    entries: [] as ReadonlyArray<PullRequestListEntry>,
                    errors: [
                      {
                        projectId: target.project.id,
                        projectTitle: target.project.title,
                        message: `${target.repository} could not be read.`,
                      },
                    ] satisfies ReadonlyArray<PullRequestListProjectError>,
                    cursor: null as string | null,
                    truncated: false,
                    cursorError: false,
                    key,
                    cause: read.failure,
                  };
                }
                const { page, observedAt } = read.success;
                const entries = page.items.map((item): PullRequestListEntry => ({
                  provider: GITHUB_PROVIDER,
                  host: target.host,
                  projectId: target.project.id,
                  projectTitle: target.project.title,
                  repository: target.repository,
                  number: item.number,
                  title: item.title,
                  url: item.url,
                  author: item.author,
                  headBranch: item.headBranch,
                  baseBranch: item.baseBranch,
                  state: item.state,
                  isDraft: item.isDraft,
                  mergeability: item.mergeability,
                  additions: item.additions,
                  deletions: item.deletions,
                  createdAt: item.createdAt,
                  updatedAt: item.updatedAt,
                  observedAt,
                  viewerReviewRequested:
                    item.author?.login.toLowerCase() !== target.viewer.toLowerCase() &&
                    item.reviewRequestLogins.some(
                      (login) => login.toLowerCase() === target.viewer.toLowerCase(),
                    ),
                  labels: item.labels,
                  ...(item.stack == null ? {} : { stack: item.stack }),
                  ...(item.reviewDecision == null ? {} : { reviewDecision: item.reviewDecision }),
                  ...(item.checksState == null ? {} : { checksState: item.checksState }),
                }));
                const nextCursor =
                  page.truncated && page.nextCursor !== null
                    ? wrapCursor(page.nextCursor, key, target, input)
                    : null;
                return {
                  entries,
                  errors: [] as ReadonlyArray<PullRequestListProjectError>,
                  cursor:
                    nextCursor !== null && nextCursor.length <= MAX_CURSOR_LENGTH
                      ? nextCursor
                      : null,
                  truncated: page.truncated,
                  cursorError: nextCursor !== null && nextCursor.length > MAX_CURSOR_LENGTH,
                  key,
                  cause: null as GitHubError | null,
                };
              }),
            );
          },
          { concurrency: REPOSITORY_CONCURRENCY },
        );

        if (selectedRepos.length > 0 && batches.every((batch) => batch.cause !== null)) {
          const cause = batches[0]?.cause;
          if (cause !== undefined && cause !== null) return yield* githubReadError("list")(cause);
        }

        const nextCursors: Record<string, string> = {};
        for (const batch of batches) {
          if (batch.cursorError) {
            return yield* new PullRequestOperationError({
              operation: "list",
              detail: "The pull request list could not be continued.",
            });
          }
          if (batch.cursor !== null) nextCursors[batch.key] = batch.cursor;
        }
        return {
          viewers,
          providers,
          entries: batches
            .flatMap((batch) => batch.entries)
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          errors: [...errors, ...batches.flatMap((batch) => batch.errors)],
          truncated: batches.some((batch) => batch.truncated),
          nextCursors,
        };
      });

    const listStats: (
      input: PullRequestListStatsInput,
    ) => Effect.Effect<PullRequestListStatsResult, ListingError> = (input) =>
      Effect.gen(function* () {
        if (input.refs.length === 0) return { stats: [] };
        const resolved = yield* Effect.forEach(
          input.refs,
          (ref) =>
            repositories.resolve(ref).pipe(
              Effect.result,
              Effect.map((result) => ({ ref, result })),
            ),
          { concurrency: REPOSITORY_CONCURRENCY },
        );

        const projectsByRepository = new Map<
          string,
          Array<{
            readonly ref: PullRequestRef;
            readonly target: ResolvedPullRequestRepository;
          }>
        >();
        const unhandled: Array<ListingError> = [];
        for (const { ref, result } of resolved) {
          if (Result.isFailure(result)) {
            if (
              result.failure._tag === "PullRequestUnavailableError" &&
              result.failure.reason === "provider-unsupported"
            )
              continue;
            unhandled.push(result.failure);
            continue;
          }
          const target = result.success;
          const key = cursorKey(target.host, target.repository);
          const group = projectsByRepository.get(key);
          const entry = { ref, target };
          if (group === undefined) projectsByRepository.set(key, [entry]);
          else if (
            !group.some(
              ({ ref: current }) =>
                current.projectId === ref.projectId && current.number === ref.number,
            )
          ) {
            group.push(entry);
          }
        }
        if (projectsByRepository.size === 0 && unhandled.length > 0) return yield* unhandled[0]!;
        const stats = yield* Effect.forEach(
          [...projectsByRepository.values()],
          (entries) => {
            const target = entries[0]!.target;
            const numbers = [...new Set(entries.map(({ ref }) => ref.number))].toSorted(
              (left, right) => left - right,
            );
            return cachedStats({ target, numbers }).pipe(
              Effect.mapError(githubReadError("listStats")),
              Effect.map((rows) => {
                const byNumber = new Map(rows.map((row) => [row.number, row]));
                return entries.flatMap(
                  ({ ref, target: projectTarget }): ReadonlyArray<PullRequestDiffStat> => {
                    const row = byNumber.get(ref.number);
                    return row === undefined
                      ? []
                      : [
                          {
                            projectId: projectTarget.project.id,
                            repository: projectTarget.repository,
                            number: ref.number,
                            additions: row.additions,
                            deletions: row.deletions,
                          },
                        ];
                  },
                );
              }),
            );
          },
          { concurrency: REPOSITORY_CONCURRENCY },
        );
        return { stats: stats.flat() };
      });

    return { list, listStats };
  });

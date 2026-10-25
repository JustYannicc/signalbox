import {
  resolvePullRequestAuthorFilter,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
} from "@t3tools/contracts";
import { PullRequestBatchesGraphQLGroup } from "@t3tools/source-control-github/server/pullRequestBatches.graphql";
import {
  PullRequestList,
  PullRequestSearch,
} from "@t3tools/source-control-github/server/pullRequestListings.graphql";
import {
  toPullRequestRows,
  type GitHubPullRequestListItem,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RequestResolver from "effect/RequestResolver";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  GraphQLClient,
  GraphQLClientError,
  GraphQLProtocol,
  GraphQLResolver,
} from "effect/graphql";

import { GitHubError, parseRepository, unreadable, type GitHubApi } from "./GitHubApi.ts";

const SEARCH_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4_096;
const STATS_ALIASES_PER_REQUEST = 25;
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

type CursorSource = "search" | "repository";

interface ListingCursor {
  readonly source: CursorSource;
  readonly after: string;
}

export interface GitHubPullRequestListInput {
  readonly repository: string;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly limit: number;
  readonly query?: string;
  /** Opaque cursor returned by the previous page. */
  readonly cursor?: string;
  readonly filters?: PullRequestListFilters;
}

export interface GitHubPullRequestListPage {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  /** Raw GraphQL nodes, including rows the shared converter cannot read. */
  readonly rawCount: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const genericReadFailure = (operation: string, status = 200) =>
  new GitHubError({
    operation,
    status,
    message: "GitHub could not complete this pull request read.",
  });
const isGitHubError = Schema.is(GitHubError);

const isNotFoundOnly = (error: unknown) =>
  GraphQLClientError.isGraphQLClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.errors.every((graphQlError) => graphQlError["type"] === "NOT_FOUND");

const statsGraphQlError = (error: unknown) => {
  if (isGitHubError(error)) return error;
  if (
    GraphQLClientError.isGraphQLClientError(error) &&
    error.reason._tag === "TransportError" &&
    isGitHubError(error.reason.cause)
  ) {
    return error.reason.cause;
  }
  const status =
    GraphQLClientError.isGraphQLClientError(error) && error.reason._tag === "ResponseError"
      ? (error.reason.status ?? 200)
      : 200;
  return genericReadFailure("listPullRequestStats", status);
};

const statsProtocol = (api: GitHubApi, token: string) =>
  Layer.succeed(GraphQLProtocol.GraphQLProtocol, {
    execute: (request) =>
      Effect.gen(function* () {
        const variables = isRecord(request.variables) ? request.variables : {};
        const text = yield* api.graphql("listPullRequestStats", token, request.query, variables);
        if (text === null) return yield* genericReadFailure("listPullRequestStats", 404);
        return { body: Option.getOrElse(decodeJson(text), () => null), status: 200 };
      }).pipe(
        Effect.mapError(
          (error) =>
            new GraphQLClientError.TransportError({
              description: error.message,
              status: error.status,
              cause: error,
            }),
        ),
      ),
    subscribe: () => Stream.empty,
  });

const cursorError = () =>
  new GitHubError({
    operation: "listPullRequests",
    status: 400,
    message: "The pull request list could not be continued.",
  });

const encodeCursor = (cursor: ListingCursor) => JSON.stringify(cursor);

const decodeCursor = (raw: string | undefined): ListingCursor | null | GitHubError => {
  if (raw === undefined) return null;
  if (raw.length > MAX_CURSOR_LENGTH) return cursorError();
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      (value.source !== "search" && value.source !== "repository") ||
      typeof value.after !== "string" ||
      value.after.length === 0 ||
      value.after.length > MAX_CURSOR_LENGTH
    ) {
      return cursorError();
    }
    return { source: value.source, after: value.after };
  } catch {
    return cursorError();
  }
};

const graphQlData = (
  api: GitHubApi,
  token: string,
  operation: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const text = yield* api.graphql(operation, token, query, variables);
    if (text === null) return yield* genericReadFailure(operation, 404);

    const decoded = decodeJson(text);
    if (Option.isNone(decoded) || !isRecord(decoded.value)) return yield* unreadable(operation);
    const answer = decoded.value;
    if (
      answer.errors !== undefined &&
      (!Array.isArray(answer.errors) || answer.errors.length > 0)
    ) {
      return yield* genericReadFailure(operation);
    }
    if (!isRecord(answer.data)) return yield* unreadable(operation);
    return answer.data;
  });

const searchPhrase = (query: string) =>
  `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const qualifierValue = (value: string) => `"${value.replaceAll('"', "").trim()}"`;

const reviewQualifiers = {
  approved: "approved",
  "changes-requested": "changes_requested",
  "review-required": "required",
  none: "none",
} as const;

const filterQualifiers = (filters: PullRequestListFilters | undefined, viewer: string) => {
  if (filters === undefined) return [];
  return [
    ...(filters.labels ?? []).flatMap((group) =>
      group.length === 0 ? [] : [`label:${group.map(qualifierValue).join(",")}`],
    ),
    ...(filters.excludedLabels ?? []).map((label) => `-label:${qualifierValue(label)}`),
    ...(filters.author === undefined
      ? []
      : [`author:${qualifierValue(resolvePullRequestAuthorFilter(filters.author, viewer))}`]),
    ...(filters.draft === undefined ? [] : [`draft:${filters.draft === "only"}`]),
    ...(filters.review === undefined ? [] : [`review:${reviewQualifiers[filters.review]}`]),
    ...(filters.checks === undefined
      ? []
      : [`status:${filters.checks === "passing" ? "success" : "failure"}`]),
  ];
};

const searchQuery = (input: GitHubPullRequestListInput, repository: string): string => {
  const query = input.query?.trim() ?? "";
  return [
    "is:pr",
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    ...filterQualifiers(input.filters, input.viewer),
    "sort:updated-desc",
    `repo:${repository}`,
  ].join(" ");
};

const states = {
  all: ["OPEN", "CLOSED", "MERGED"],
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
} as const;

const matchesFilters = (
  item: GitHubPullRequestListItem,
  filters: PullRequestListFilters | undefined,
  viewer: string,
) => {
  if (filters === undefined) return true;
  const labels = new Set(item.labels.map((label) => label.name.trim().toLowerCase()));
  const holds = (label: string) => labels.has(label.trim().toLowerCase());
  return (
    (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? item.reviewDecision === null
        : item.reviewDecision === filters.review)) &&
    (filters.checks === undefined || item.checksState === filters.checks) &&
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      item.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
};

const matchesRow = (item: GitHubPullRequestListItem, input: GitHubPullRequestListInput) => {
  const viewer = input.viewer.toLowerCase();
  const matchesState = input.state === "all" || item.state === input.state;
  const matchesInvolvement =
    input.involvement === "all" ||
    (input.involvement === "authored"
      ? item.author?.login.toLowerCase() === viewer
      : item.hasTeamReviewRequest ||
        item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer));
  return matchesState && matchesInvolvement && matchesFilters(item, input.filters, input.viewer);
};

interface ListingConnection {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: ReadonlyArray<unknown> | null;
}

const connectionOf = (value: unknown): ListingConnection | null => {
  if (!isRecord(value) || !isRecord(value.pageInfo)) return null;
  const { hasNextPage, endCursor } = value.pageInfo;
  if (
    typeof hasNextPage !== "boolean" ||
    (endCursor !== null && typeof endCursor !== "string") ||
    (value.nodes !== null && !Array.isArray(value.nodes))
  ) {
    return null;
  }
  return {
    pageInfo: { hasNextPage, endCursor: endCursor as string | null },
    nodes: value.nodes as ReadonlyArray<unknown> | null,
  };
};

const listingPage = (
  source: CursorSource,
  connection: ListingConnection,
): GitHubPullRequestListPage | GitHubError => {
  const page = toPullRequestRows(connection);
  if (page.hasNextPage && page.endCursor === null) return unreadable("listPullRequests");
  return {
    items: page.rows.map((row) => row.item),
    rawCount: page.rawCount,
    truncated: page.hasNextPage,
    nextCursor:
      page.hasNextPage && page.endCursor !== null
        ? encodeCursor({ source, after: page.endCursor })
        : null,
  };
};

const readSearchPage = (
  api: GitHubApi,
  token: string,
  input: GitHubPullRequestListInput,
  repository: string,
  after: string | null,
) =>
  Effect.gen(function* () {
    const data = yield* graphQlData(api, token, "listPullRequests", PullRequestSearch.document, {
      q: searchQuery(input, repository),
      first: Math.min(Math.max(Math.trunc(input.limit), 1), SEARCH_PAGE_SIZE),
      after,
      stacks: api.host === "github.com",
      stats: true,
    });
    const connection = connectionOf(data.search);
    if (connection === null) return yield* unreadable("listPullRequests");
    const page = listingPage("search", connection);
    if (isGitHubError(page)) return yield* page;
    return { ...page, items: page.items.filter((item) => matchesRow(item, input)) };
  });

const readRepositoryPage = (
  api: GitHubApi,
  token: string,
  input: GitHubPullRequestListInput,
  repository: string,
  after: string | null,
) =>
  Effect.gen(function* () {
    const [owner, name] = repository.split("/");
    if (owner === undefined || name === undefined) {
      return yield* new GitHubError({
        operation: "listPullRequests",
        status: 400,
        message: "The repository name is not valid.",
      });
    }
    const data = yield* graphQlData(api, token, "listPullRequests", PullRequestList.document, {
      owner,
      name,
      states: states[input.state],
      first: Math.min(Math.max(Math.trunc(input.limit), 1), SEARCH_PAGE_SIZE),
      after,
      stacks: api.host === "github.com",
      stats: true,
    });
    const repositoryResult = data.repository;
    // A null repository is unavailable to this credential; it must not look like an empty list.
    if (repositoryResult === null) return yield* genericReadFailure("listPullRequests", 404);
    const connection = isRecord(repositoryResult)
      ? connectionOf(repositoryResult.pullRequests)
      : null;
    if (connection === null) return yield* unreadable("listPullRequests");
    const page = listingPage("repository", connection);
    if (isGitHubError(page)) return yield* page;
    return { ...page, items: page.items.filter((item) => matchesRow(item, input)) };
  });

/** Lists one GitHub repository, keeping search and repository cursors on their own connections. */
export const listGitHubPullRequests = (
  api: GitHubApi,
  token: string,
  input: GitHubPullRequestListInput,
) =>
  Effect.gen(function* () {
    const parsedRepository = parseRepository(input.repository);
    if (parsedRepository === null || !SEARCH_REPOSITORY.test(parsedRepository)) {
      return yield* new GitHubError({
        operation: "listPullRequests",
        status: 400,
        message: "The repository name is not valid.",
      });
    }
    if (!Number.isInteger(input.limit) || input.limit < 1) return yield* cursorError();

    const cursor = decodeCursor(input.cursor);
    if (isGitHubError(cursor)) return yield* cursor;
    if (cursor?.source === "repository") {
      return yield* readRepositoryPage(api, token, input, parsedRepository, cursor.after);
    }

    const page = yield* readSearchPage(api, token, input, parsedRepository, cursor?.after ?? null);
    if (page.items.length > 0 || cursor !== null || (input.query?.trim().length ?? 0) > 0) {
      return page;
    }
    return yield* readRepositoryPage(api, token, input, parsedRepository, null);
  });

/** Reads line counts in the same 25-alias batches used by the self-hosted provider. */
export const listGitHubPullRequestStats = (
  api: GitHubApi,
  token: string,
  input: { readonly repository: string; readonly numbers: ReadonlyArray<number> },
) =>
  Effect.gen(function* () {
    const repository = parseRepository(input.repository);
    if (repository === null || !SEARCH_REPOSITORY.test(repository)) {
      return yield* new GitHubError({
        operation: "listPullRequestStats",
        status: 400,
        message: "The repository name is not valid.",
      });
    }
    const [owner, name] = repository.split("/");
    if (owner === undefined || name === undefined) {
      return yield* new GitHubError({
        operation: "listPullRequestStats",
        status: 400,
        message: "The repository name is not valid.",
      });
    }
    const numbers = [...new Set(input.numbers)];
    if (numbers.some((number) => !Number.isInteger(number) || number < 1)) {
      return yield* new GitHubError({
        operation: "listPullRequestStats",
        status: 400,
        message: "The pull request reference is not valid.",
      });
    }

    const client = yield* GraphQLClient.make(PullRequestBatchesGraphQLGroup).pipe(
      Effect.provide(statsProtocol(api, token)),
    );
    const statsResolver = GraphQLResolver.aliased(client.PullRequestStats).pipe(
      RequestResolver.batchN(STATS_ALIASES_PER_REQUEST),
    );
    const stats = yield* Effect.forEach(
      numbers,
      (number) =>
        GraphQLResolver.request({ owner, name, number }, statsResolver).pipe(
          Effect.flatMap((result) => {
            const repositoryResult = result.repository;
            if (repositoryResult === null) {
              return Effect.fail(genericReadFailure("listPullRequestStats", 404));
            }
            const pullRequest = repositoryResult.pullRequest;
            if (pullRequest === null) return Effect.succeed([]);
            return Effect.succeed([
              {
                repository,
                number,
                additions: pullRequest.additions,
                deletions: pullRequest.deletions,
              } satisfies GitHubPullRequestStat,
            ]);
          }),
          Effect.catchIf(isNotFoundOnly, () => Effect.succeed([])),
          Effect.mapError(statsGraphQlError),
        ),
      { concurrency: "unbounded" },
    );
    return stats.flat();
  });

/** Resolves the account ID and login from the token used for subsequent GitHub reads. */
export const getGitHubRoutingIdentity = (api: GitHubApi, token: string) =>
  Effect.gen(function* () {
    const viewer = yield* api.viewer(token);
    if (viewer === null || !Number.isInteger(viewer.id) || viewer.id < 1 || !viewer.login.trim()) {
      return yield* genericReadFailure("routeIdentity", viewer === null ? 404 : 200);
    }
    return { accountId: String(viewer.id), viewer: viewer.login };
  });

import {
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodePullRequestStacksJson,
  pullRequestChecksFromContexts,
  toPullRequestCheckContextsPage,
  toPullRequestCore,
  toPullRequestPreview,
  toPullRequestSummary,
  type GitHubPullRequestCore,
  type GitHubPullRequestSummary,
  type GitHubPullRequestStack,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import { PullRequestSummary as PullRequestSummaryQuery } from "@t3tools/source-control-github/server/pullRequestBatches.graphql";
import {
  PullRequestCheckContexts,
  PullRequestCore,
  PullRequestPreview as PullRequestPreviewQuery,
} from "@t3tools/source-control-github/server/pullRequestReads.graphql";

import { ownerAndName } from "./GitHubPullRequests.ts";
import { type GitHubApi, unreadable } from "./GitHubApi.ts";
import { decodeGraphqlData } from "./GitHubGraphql.ts";
import * as GitHubReviewDiffReads from "./GitHubReviewDiffReads.ts";
import { pullRequestActivity, reviewThreadComments } from "./GitHubReviewConversationReads.ts";

export { pullRequestActivity, reviewThreadComments };

const REVIEW_PAGES = 10;

const decodeSummary = decodeGraphqlData(PullRequestSummaryQuery.result);
const decodeCore = decodeGraphqlData(PullRequestCore.result);
const decodeCheckContexts = decodeGraphqlData(PullRequestCheckContexts.result);
const decodePreview = decodeGraphqlData(PullRequestPreviewQuery.result);

const operationError = (operation: string) => unreadable(operation);

/** The linked-thread snapshot, using the same summary query and converter as the host provider. */
export const pullRequestSummary = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const text = yield* api.graphql("pullRequestSummary", token, PullRequestSummaryQuery.document, {
      ...ownerAndName(repository),
      number,
      stacks: api.host === "github.com",
    });
    if (text === null) return null;
    const decoded = decodeSummary(text);
    if (Option.isNone(decoded)) return yield* operationError("pullRequestSummary");
    const pullRequest = decoded.value.repository?.pullRequest;
    return pullRequest == null ? null : toPullRequestSummary(pullRequest);
  });

/** A complete detail; a shortened check rollup is retried by head SHA before it is returned. */
export const pullRequestDetail = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const operation = "pullRequestDetail";
    const text = yield* api.graphql("pullRequestDetail", token, PullRequestCore.document, {
      ...ownerAndName(repository),
      number,
      headRef: `refs/pull/${number}/head`,
      required: api.host === "github.com",
    });
    if (text === null) return null;
    const decoded = decodeCore(text);
    if (Option.isNone(decoded)) return yield* operationError(operation);
    const core = toPullRequestCore(decoded.value);
    if (core === null || !core.checksTruncated) return core;
    if (core.headSha === null || core.headSha === undefined)
      return yield* operationError(operation);

    const contexts: Array<
      NonNullable<ReturnType<typeof toPullRequestCheckContextsPage>>["contexts"][number]
    > = [];
    let cursor: string | null = null;
    let headSha: string | null = null;
    for (let page = 0; page < REVIEW_PAGES; page += 1) {
      const pageText = yield* api.graphql(
        "pullRequestDetailChecks",
        token,
        PullRequestCheckContexts.document,
        {
          ...ownerAndName(repository),
          number,
          required: api.host === "github.com",
          after: cursor,
        },
      );
      if (pageText === null) return yield* operationError(operation);
      const pageDecoded = decodeCheckContexts(pageText);
      if (Option.isNone(pageDecoded)) return yield* operationError(operation);
      const read = toPullRequestCheckContextsPage(pageDecoded.value);
      if (read === null || (headSha !== null && read.headSha !== headSha)) {
        return yield* operationError(operation);
      }
      headSha = read.headSha;
      contexts.push(...read.contexts);
      cursor = read.nextCursor;
      if (cursor === null) break;
    }
    if (cursor !== null || headSha !== core.headSha) return yield* operationError(operation);
    return { ...core, ...pullRequestChecksFromContexts(contexts), checksTruncated: false };
  });

export const pullRequestPreview = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const text = yield* api.graphql("pullRequestPreview", token, PullRequestPreviewQuery.document, {
      ...ownerAndName(repository),
      number,
    });
    if (text === null) return null;
    const decoded = decodePreview(text);
    if (Option.isNone(decoded)) return yield* operationError("pullRequestPreview");
    return toPullRequestPreview(decoded.value);
  });

export const pullRequestStack = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  includeDetails = false,
) =>
  Effect.gen(function* () {
    const { owner, name } = ownerAndName(repository);
    const first = yield* api.rest("pullRequestStack", token, `/repos/${owner}/${name}/stacks`, {
      pull_request: String(number),
    });
    if (first === null) return null;
    const decoded = decodePullRequestStacksJson(first);
    if (Result.isFailure(decoded)) return yield* operationError("pullRequestStack");
    const stack = decoded.success;
    if (!includeDetails || stack === null) return stack;
    const detail = yield* api.rest(
      "pullRequestStack",
      token,
      `/repos/${owner}/${name}/stacks/${stack.number}`,
    );
    if (detail === null) return null;
    const detailDecoded = decodePullRequestStacksJson(`[${detail}]`);
    return Result.isSuccess(detailDecoded)
      ? detailDecoded.success
      : yield* operationError("pullRequestStack");
  });

export const pullRequestDiff = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  input: PullRequestDiffInput,
): Effect.Effect<PullRequestDiffResult | null, import("./GitHubApi.ts").GitHubError> =>
  GitHubReviewDiffReads.pullRequestDiff(api, token, repository, number, input);

export const pullRequestDiffFileContents = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  input: PullRequestDiffFileContentsInput,
): Effect.Effect<PullRequestDiffFileContentsResult | null, import("./GitHubApi.ts").GitHubError> =>
  GitHubReviewDiffReads.pullRequestDiffFileContents(api, token, repository, number, input);

export type { GitHubPullRequestCore, GitHubPullRequestStack, GitHubPullRequestSummary };

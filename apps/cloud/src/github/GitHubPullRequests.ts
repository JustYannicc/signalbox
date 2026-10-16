import {
  type PullRequestCheck,
  type PullRequestCommentKind,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  type GitHubCheckContext,
  pullRequestChecksFromContexts,
  toPullRequestCheckContextsPage,
  toPullRequestSummary,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import { PullRequestSummary } from "@t3tools/source-control-github/server/pullRequestBatches.graphql";
import { PullRequestCheckContexts } from "@t3tools/source-control-github/server/pullRequestReads.graphql";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SnapshotFields } from "../thread/pullRequests/pullRequestLinks.ts";
import { type GitHubApi, GitHubError } from "./GitHubApi.ts";

/**
 * A pull request as the cloud reads it from GitHub, with the user's token:
 * its summary as a thread link's snapshot, its head commit's checks, and its
 * conversation. The summary and checks go through upstream's own GraphQL
 * queries and decoders (`@t3tools/source-control-github`), so `checksState`,
 * `mergeability` and `reviewDecision` mean exactly what they mean on a
 * self-hosted server.
 */

/** Pages read of one list before giving up on its tail. */
const PAGE_LIMIT = 10;
const PER_PAGE = 100;

const unreadable = (operation: string) =>
  new GitHubError({
    operation,
    status: 200,
    message: "GitHub sent an answer Signalbox does not understand.",
  });

export const ownerAndName = (repository: string) => {
  const [owner, name] = repository.split("/");
  return { owner, name };
};

const decodeSnapshot = Schema.decodeUnknownOption(ThreadPullRequestSnapshot);
const decodeSummaryAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: PullRequestSummary.result })),
);
const decodeCheckContextsAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: PullRequestCheckContexts.result })),
);

/**
 * The pull request's host state as a link keeps it, without `syncedAt`, the
 * way upstream's sync reactor builds it from a summary. Null when GitHub has
 * no such pull request (or won't show it to this token).
 */
export const pullRequestSnapshot = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const text = yield* api.graphql("pullRequestSummary", token, PullRequestSummary.document, {
      ...ownerAndName(repository),
      number,
      stacks: false,
    });
    if (text === null) return null;
    const decoded = decodeSummaryAnswer(text);
    if (Option.isNone(decoded)) return yield* unreadable("pullRequestSummary");
    const pullRequest = decoded.value.data.repository?.pullRequest;
    if (pullRequest == null) return null;
    const summary = toPullRequestSummary(pullRequest);
    const fields: SnapshotFields = {
      state: summary.state,
      title: summary.title,
      headBranch: summary.headBranch,
      baseBranch: summary.baseBranch,
      isDraft: summary.isDraft,
      updatedAt: summary.updatedAt,
      closedAt: summary.closedAt,
      mergedAt: summary.mergedAt,
      author: summary.author,
      additions: summary.additions,
      deletions: summary.deletions,
      changedFiles: summary.changedFiles,
      reviewDecision: summary.reviewDecision,
      checksState: summary.checksState,
      mergeability: summary.mergeability,
    };
    // Checked here, so a field GitHub left blank never reaches the thread's log.
    const checked = decodeSnapshot({ ...fields, syncedAt: summary.updatedAt });
    if (Option.isNone(checked)) return yield* unreadable("pullRequestSummary");
    const { syncedAt: _syncedAt, ...snapshot } = checked.value;
    return snapshot;
  });

/**
 * Every check on the head commit, deduped the way upstream's detail reads
 * them, with the commit they're for (null unless they were read whole for
 * one commit); null when gone.
 */
export const pullRequestChecksAtHead = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const contexts: Array<GitHubCheckContext> = [];
    let headSha: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      const text: string | null = yield* api.graphql(
        "pullRequestChecks",
        token,
        PullRequestCheckContexts.document,
        // An older Enterprise server may not know `isRequired`, so only github.com asks for it.
        { ...ownerAndName(repository), number, required: api.host === "github.com", after },
      );
      if (text === null) return null;
      const decoded = decodeCheckContextsAnswer(text);
      if (Option.isNone(decoded)) return yield* unreadable("pullRequestChecks");
      const page = toPullRequestCheckContextsPage(decoded.value.data);
      if (page === null) return null;
      // Pages of two heads (a push between them) are about no one commit.
      if (headSha !== null && page.headSha !== headSha) return { headSha: null, checks: [] };
      headSha = page.headSha;
      contexts.push(...page.contexts);
      after = page.nextCursor;
      if (after === null) break;
    }
    // A list cut short isn't all the head's checks, so it names no commit.
    if (after !== null) headSha = null;
    const checks: ReadonlyArray<PullRequestCheck> = pullRequestChecksFromContexts(contexts).checks;
    return { headSha, checks };
  });

/** Every check on the head commit; null when gone. */
export const pullRequestChecks = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.map(pullRequestChecksAtHead(api, token, repository, number), (read) =>
    read === null ? null : read.checks,
  );

/** A comment or review as GitHub's REST API lists it; only the fields used. */
const RestUser = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const RestComment = Schema.Struct({
  node_id: Schema.String,
  user: RestUser,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const RestReview = Schema.Struct({
  node_id: Schema.String,
  user: RestUser,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeComments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RestComment)));
const decodeReviews = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RestReview)));

/** One remark in the conversation, as GitHub lists it. */
export interface GitHubRemark {
  readonly id: string;
  readonly kind: PullRequestCommentKind;
  readonly author: string | null;
  readonly body: string;
  readonly path: string | null;
  readonly reviewState: string | null;
  readonly url: string | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
}

/** A review state that says something by itself, unlike the container of line comments. */
const isVerdict = (state: string) =>
  state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED";

/**
 * Every page of a REST list, decoded; null when it runs past `PAGE_LIMIT`
 * pages, since remarks left out would look like none.
 */
const allPages = <A>(
  api: GitHubApi,
  token: string,
  operation: string,
  path: string,
  params: Readonly<Record<string, string>>,
  decode: (text: string) => Option.Option<ReadonlyArray<A>>,
) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const text = yield* api.rest(operation, token, path, {
        ...params,
        per_page: String(PER_PAGE),
        page: String(page),
      });
      if (text === null) return null;
      const decoded = decode(text);
      if (Option.isNone(decoded)) return yield* unreadable(operation);
      items.push(...decoded.value);
      if (decoded.value.length < PER_PAGE) return items;
    }
    return null;
  });

/**
 * Comments, line comments and reviews active since `since` (GitHub's `since`
 * is inclusive, by last update), in any order; null when the conversation
 * couldn't be read whole. A bodiless `COMMENTED` review only holds line
 * comments, which are listed themselves, so it is left out as upstream does.
 */
export const pullRequestRemarks = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  since: string,
) =>
  Effect.gen(function* () {
    const sinceParam = { since };
    const [issueComments, lineComments, reviews] = yield* Effect.all(
      [
        allPages(
          api,
          token,
          "issueComments",
          `/repos/${repository}/issues/${number}/comments`,
          sinceParam,
          decodeComments,
        ),
        allPages(
          api,
          token,
          "reviewComments",
          `/repos/${repository}/pulls/${number}/comments`,
          sinceParam,
          decodeComments,
        ),
        allPages(
          api,
          token,
          "reviews",
          `/repos/${repository}/pulls/${number}/reviews`,
          {},
          decodeReviews,
        ),
      ],
      { concurrency: 3 },
    );
    if (issueComments === null || lineComments === null || reviews === null) return null;
    const comment =
      (kind: PullRequestCommentKind) =>
      (raw: typeof RestComment.Type): GitHubRemark => ({
        id: raw.node_id,
        kind,
        author: raw.user?.login ?? null,
        body: raw.body ?? "",
        path: kind === "review-comment" ? (raw.path ?? null) : null,
        reviewState: null,
        url: raw.html_url ?? null,
        createdAt: raw.created_at,
        editedAt: raw.updated_at === raw.created_at ? null : raw.updated_at,
      });
    return [
      ...issueComments.map(comment("issue-comment")),
      ...lineComments.map(comment("review-comment")),
      ...reviews.flatMap((raw): ReadonlyArray<GitHubRemark> => {
        const submittedAt = raw.submitted_at ?? null;
        const body = raw.body ?? "";
        if (submittedAt === null || (body.trim().length === 0 && !isVerdict(raw.state))) return [];
        return [
          {
            id: raw.node_id,
            kind: "review",
            author: raw.user?.login ?? null,
            body,
            path: null,
            reviewState: raw.state,
            url: raw.html_url ?? null,
            createdAt: submittedAt,
            editedAt: null,
          },
        ];
      }),
    ];
  });

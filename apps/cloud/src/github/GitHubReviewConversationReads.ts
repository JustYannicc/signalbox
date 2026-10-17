import {
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestReaction,
  type PullRequestReviewThread,
  type PullRequestThreadCommentsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { GitHubPullRequestActivity } from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import {
  reviewThreadConversation,
  toPullRequestActivityPage,
  toReviewDismissalsPage,
  toReviewThreadCommentsPage,
  toReviewThreadPage,
  type GitHubReviewThreadComments,
  type GitHubReviewThreadPage,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import { PullRequestActivity as PullRequestActivityQuery } from "@t3tools/source-control-github/server/pullRequestReads.graphql";
import {
  ReviewDismissals,
  ReviewThreadComments,
  ReviewThreads,
} from "@t3tools/source-control-github/server/pullRequestReviews.graphql";

import { type GitHubApi, unreadable } from "./GitHubApi.ts";
import { decodeGraphqlData } from "./GitHubGraphql.ts";
import { ownerAndName } from "./GitHubPullRequests.ts";

const REVIEW_PAGES = 10;

const decodeActivity = decodeGraphqlData(PullRequestActivityQuery.result);
const decodeReviewThreads = decodeGraphqlData(ReviewThreads.result);
const decodeReviewThreadComments = decodeGraphqlData(ReviewThreadComments.result);
const decodeReviewDismissals = decodeGraphqlData(ReviewDismissals.result);

const operationError = (operation: string) => unreadable(operation);

const pullRequestActivityPages = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const remarks: Array<PullRequestComment> = [];
    let author: PullRequestActivity["author"];
    let commits: ReadonlyArray<PullRequestCommit> = [];
    let commentsAfter: string | null = null;
    let reviewsAfter: string | null = null;
    let withComments = true;
    let withReviews = true;
    for (let page = 0; page < REVIEW_PAGES && (withComments || withReviews); page += 1) {
      const text = yield* api.graphql(
        "pullRequestActivity",
        token,
        PullRequestActivityQuery.document,
        {
          ...ownerAndName(repository),
          number,
          head: page === 0,
          withComments,
          commentsAfter,
          withReviews,
          reviewsAfter,
        },
      );
      if (text === null) return yield* operationError("pullRequestActivity");
      const decoded = decodeActivity(text);
      if (Option.isNone(decoded)) return yield* operationError("pullRequestActivity");
      const read = toPullRequestActivityPage(decoded.value);
      if (read === null) return null;
      if (page === 0) {
        author = read.author ?? null;
        commits = read.commits ?? [];
      }
      remarks.push(...read.remarks);
      commentsAfter = read.nextCommentsCursor;
      reviewsAfter = read.nextReviewsCursor;
      withComments = withComments && commentsAfter !== null;
      withReviews = withReviews && reviewsAfter !== null;
    }
    if (commentsAfter !== null || reviewsAfter !== null)
      return yield* operationError("pullRequestActivity");
    return {
      author: author ?? null,
      comments: remarks.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      commits,
    } satisfies GitHubPullRequestActivity;
  });

const pullRequestReviewThreads = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const { owner, name } = ownerAndName(repository);
    const readPage = (after: string | null) =>
      api
        .graphql("pullRequestReviewThreads", token, ReviewThreads.document, {
          owner,
          name,
          number,
          after,
        })
        .pipe(
          Effect.flatMap((text) => {
            if (text === null) return operationError("pullRequestReviewThreads");
            const decoded = decodeReviewThreads(text);
            return Option.isNone(decoded)
              ? operationError("pullRequestReviewThreads")
              : Effect.succeed(toReviewThreadPage(decoded.value));
          }),
          Effect.flatMap((page) =>
            page === null ? operationError("pullRequestReviewThreads") : Effect.succeed(page),
          ),
        );

    const threads: GitHubReviewThreadPage["threads"][number][] = [];
    const avatarsByLogin = new Map<string, string>();
    const botLogins = new Set<string>();
    const reactionsById = new Map<string, ReadonlyArray<PullRequestReaction>>();
    const editedAtById = new Map<string, string>();
    const commitStats = new Map<
      string,
      { readonly additions: number; readonly deletions: number }
    >();
    let reviewers: GitHubReviewThreadPage["reviewers"] = [];
    let reactions: GitHubReviewThreadPage["reactions"] = [];
    let commits: GitHubReviewThreadPage["commits"] = [];
    let viewer: GitHubReviewThreadPage["viewer"] = { canUpdate: true, didAuthor: false };
    const dismissalsByReviewId = new Map<string, string>();
    let dismissalCursor: string | null = null;
    let cursor: string | null = null;
    let page = 0;
    do {
      const read: GitHubReviewThreadPage = yield* readPage(cursor);
      threads.push(...read.threads);
      for (const [login, avatar] of read.avatarsByLogin) avatarsByLogin.set(login, avatar);
      for (const login of read.botLogins) botLogins.add(login);
      if (page === 0) {
        reviewers = read.reviewers;
        reactions = read.reactions;
        for (const [id, values] of read.reactionsById) reactionsById.set(id, values);
        for (const [id, editedAt] of read.editedAtById) editedAtById.set(id, editedAt);
        commits = read.commits;
        viewer = read.viewer;
        for (const [id, message] of read.dismissalsByReviewId)
          dismissalsByReviewId.set(id, message);
        dismissalCursor = read.nextDismissalCursor;
        for (const [oid, stat] of read.commitStats) commitStats.set(oid, stat);
      }
      cursor = read.nextCursor;
      page += 1;
    } while (cursor !== null && page < REVIEW_PAGES);
    if (cursor !== null) return yield* operationError("pullRequestReviewThreads");

    let after = dismissalCursor;
    const seenDismissalCursors = new Set<string>();
    for (let page = 0; after !== null && page < REVIEW_PAGES; page += 1) {
      if (seenDismissalCursors.has(after)) return yield* operationError("pullRequestReviewThreads");
      seenDismissalCursors.add(after);
      const text = yield* api.graphql(
        "pullRequestReviewDismissals",
        token,
        ReviewDismissals.document,
        {
          owner,
          name,
          number,
          after,
        },
      );
      if (text === null) return yield* operationError("pullRequestReviewThreads");
      const decoded = decodeReviewDismissals(text);
      if (Option.isNone(decoded)) return yield* operationError("pullRequestReviewThreads");
      const read = toReviewDismissalsPage(decoded.value);
      if (read === null) return yield* operationError("pullRequestReviewThreads");
      for (const [id, message] of read.dismissalsByReviewId) dismissalsByReviewId.set(id, message);
      after = read.nextCursor;
    }
    if (after !== null) return yield* operationError("pullRequestReviewThreads");

    const reviewThreads = threads.map(({ thread, commentCount, nextCommentCursor }) => ({
      ...thread,
      commentCount,
      ...(nextCommentCursor === null ? {} : { nextCommentsCursor: nextCommentCursor }),
    }));
    return {
      comments: reviewThreadConversation(reviewThreads),
      dismissalsByReviewId,
      reviewThreads,
      commentCount: threads.reduce((total, entry) => total + entry.commentCount, 0),
      truncated: threads.some((entry) => entry.nextCommentCursor !== null),
      reviewThreadsTruncated: false,
      reactions,
      reactionsById,
      editedAtById,
      reviewers,
      avatarsByLogin,
      botLogins,
      commitStats,
      commits,
      viewer,
    } satisfies GitHubReviewThreadComments;
  });

const loginAvatarUrl = (login: string, host: string) =>
  /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;

const withReviewAvatar = (
  actor: PullRequestComment["author"],
  avatarsByLogin: ReadonlyMap<string, string>,
  botLogins: ReadonlySet<string>,
  host: string,
) => {
  if (actor === null) return null;
  if (actor.avatarUrl !== null)
    return botLogins.has(actor.login) ? { ...actor, isBot: true } : actor;
  const avatarUrl = avatarsByLogin.get(actor.login) ?? loginAvatarUrl(actor.login, host);
  return {
    ...actor,
    ...(botLogins.has(actor.login) ? { isBot: true } : {}),
    ...(avatarUrl === null ? {} : { avatarUrl }),
  };
};

const rendersEmpty = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;

/** The full activity view combines timeline pages with independently paged review threads. */
export const pullRequestActivity = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
) =>
  Effect.gen(function* () {
    const [activity, reviewThreads] = yield* Effect.all(
      [
        pullRequestActivityPages(api, token, repository, number),
        pullRequestReviewThreads(api, token, repository, number),
      ],
      { concurrency: 2 },
    );
    if (activity === null || reviewThreads === null) return null;
    const comments = [...activity.comments, ...reviewThreads.comments]
      .map((comment): PullRequestComment => ({
        ...comment,
        body:
          comment.kind === "review" &&
          comment.reviewState?.toUpperCase() === "DISMISSED" &&
          rendersEmpty(comment.body)
            ? (reviewThreads.dismissalsByReviewId.get(comment.id) ?? comment.body)
            : comment.body,
        author: withReviewAvatar(
          comment.author,
          reviewThreads.avatarsByLogin,
          reviewThreads.botLogins,
          api.host,
        ),
        reactions: comment.reactions ?? reviewThreads.reactionsById.get(comment.id) ?? [],
        editedAt: reviewThreads.editedAtById.get(comment.id) ?? comment.editedAt ?? null,
      }))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    const commits = (
      reviewThreads.commits.length > 0 ? reviewThreads.commits : activity.commits
    ).map(
      (commit) =>
        ({
          ...commit,
          ...reviewThreads.commitStats.get(commit.oid),
          authors: commit.authors?.map(
            (author) =>
              withReviewAvatar(
                author,
                reviewThreads.avatarsByLogin,
                reviewThreads.botLogins,
                api.host,
              ) ?? author,
          ),
        }) satisfies PullRequestCommit,
    );
    const threads: ReadonlyArray<PullRequestReviewThread> = reviewThreads.reviewThreads.map(
      (thread) => ({
        ...thread,
        comments: thread.comments.map((comment) => ({
          ...comment,
          author: withReviewAvatar(
            comment.author,
            reviewThreads.avatarsByLogin,
            reviewThreads.botLogins,
            api.host,
          ),
        })),
      }),
    );
    return {
      author: withReviewAvatar(
        activity.author ?? null,
        reviewThreads.avatarsByLogin,
        reviewThreads.botLogins,
        api.host,
      ),
      reviewers: reviewThreads.reviewers,
      reactions: reviewThreads.reactions,
      commits,
      comments,
      commentCount: activity.comments.length + reviewThreads.commentCount,
      commentsTruncated: reviewThreads.truncated,
      reviewThreadsTruncated: reviewThreads.reviewThreadsTruncated,
      reviewThreads: threads,
    } satisfies PullRequestActivity;
  });

export const reviewThreadComments = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  threadId: string,
  cursor: string,
) =>
  Effect.gen(function* () {
    const text = yield* api.graphql("reviewThreadComments", token, ReviewThreadComments.document, {
      ...ownerAndName(repository),
      number,
      threadId,
      after: cursor,
    });
    if (text === null) return yield* operationError("reviewThreadComments");
    const decoded = decodeReviewThreadComments(text);
    if (Option.isNone(decoded)) return yield* operationError("reviewThreadComments");
    const page = toReviewThreadCommentsPage(decoded.value);
    if (!page.belongsToPullRequest) return yield* operationError("reviewThreadComments");
    return {
      comments: page.comments,
      nextCursor: page.nextCursor,
    } satisfies PullRequestThreadCommentsResult;
  });

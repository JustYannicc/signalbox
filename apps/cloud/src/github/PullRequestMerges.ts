import type {
  PullRequestCheck,
  PullRequestMergeability,
  PullRequestMergeMethod,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";
import {
  PullRequestBranchToDelete,
  PullRequestSourceBranch,
} from "@t3tools/source-control-github/server/pullRequestReads.graphql";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitHub } from "./GitHub.ts";
import { GitHubError } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { ownerAndName, pullRequestChecksAtHead } from "./GitHubPullRequests.ts";

/**
 * What a merge gate reads and does on GitHub, with the user's own GitHub
 * connection: `signalbox.pull_request_read` and `signalbox.pull_request_action`
 * in the cloud (`automations/cloudBuiltinTools.ts`). The read is the merge's
 * evidence, every part of it about one head commit; the merge names that
 * commit, so GitHub itself refuses it once anything newer landed (#461).
 */

/** A pull request on GitHub; `host` is checked against the GitHub this cloud reaches. */
export interface PullRequestTarget {
  readonly host?: string;
  readonly repository: string;
  readonly number: number;
}

/** A pull request as a merge gate judges it. A null part is one GitHub didn't answer. */
export interface MergeEvidence {
  readonly title: string;
  readonly state: PullRequestState;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  /** GitHub's own decision; approvals by apps alone don't count here as they do in upstream's summary. */
  readonly reviewDecision: PullRequestReviewDecision | null;
  /** The checks on `headSha`; null when they couldn't be read whole for that commit. */
  readonly checks: ReadonlyArray<PullRequestCheck> | null;
  /** Review threads nobody resolved; null past the first hundred. */
  readonly openThreads: number | null;
  /** Every changed path; null past `FILE_PAGES` pages or when the head moved while reading. */
  readonly files: ReadonlyArray<string> | null;
}

export type MergeOutcome =
  | { readonly _tag: "merged" }
  /** The head isn't the commit the merge named anymore; nothing merged. */
  | { readonly _tag: "moved" };

export class PullRequestMerges extends Context.Service<
  PullRequestMerges,
  {
    readonly evidence: (target: PullRequestTarget) => Effect.Effect<MergeEvidence, GitHubError>;
    /** The pull request's state now, in one small read. */
    readonly state: (target: PullRequestTarget) => Effect.Effect<PullRequestState, GitHubError>;
    readonly merge: (
      target: PullRequestTarget,
      input: { readonly headSha?: string; readonly method?: PullRequestMergeMethod },
    ) => Effect.Effect<MergeOutcome, GitHubError>;
    /**
     * Deletes a merged or closed pull request's head branch the way upstream's
     * delete-branch does: never a default or base branch, and only while it is
     * still at the pull request's head. False when it was gone already.
     */
    readonly deleteBranch: (target: PullRequestTarget) => Effect.Effect<boolean, GitHubError>;
  }
>()("@signalbox/cloud/github/PullRequestMerges") {}

const FILE_PAGES = 10;

const EVIDENCE_QUERY = `query PullRequestMergeEvidence($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title state isDraft mergeable reviewDecision headRefOid
      reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
      files(first: 100) { nodes { path } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
const FILES_QUERY = `query PullRequestMergeFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      files(first: 100, after: $after) { nodes { path } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
const DELETE_BRANCH_MUTATION = `mutation DeletePullRequestBranch($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;
const NO_OBJECT = "0".repeat(40);

const Files = Schema.NullOr(
  Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ path: Schema.String })),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);
const answerOf = <S extends Schema.Codec<unknown, unknown>>(pullRequest: S) =>
  Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.Struct({
          repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(pullRequest) })),
        }),
      }),
    ),
  );
const decodeEvidence = answerOf(
  Schema.Struct({
    title: Schema.String,
    state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
    isDraft: Schema.Boolean,
    mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    reviewDecision: Schema.NullOr(
      Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
    ),
    headRefOid: Schema.String,
    reviewThreads: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    }),
    files: Files,
  }),
);
const decodeFiles = answerOf(Schema.Struct({ headRefOid: Schema.String, files: Files }));
const decodeBranch = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: PullRequestBranchToDelete.result })),
);
const decodeSource = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: PullRequestSourceBranch.result })),
);
const decodeDeleted = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.NullOr(Schema.Struct({ updateRefs: Schema.NullOr(Schema.Unknown) })),
      errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
    }),
  ),
);

const STATES: Readonly<Record<string, PullRequestState>> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};
const MERGEABILITY = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
} as const;
const DECISIONS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
} as const;

const failure = (operation: string, message: string, status = 200) =>
  new GitHubError({ operation, status, message });
const unreadable = (operation: string) =>
  failure(operation, "GitHub sent an answer Signalbox does not understand.");

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;

  const tokenFor = (operation: string, target: PullRequestTarget) =>
    Effect.gen(function* () {
      if (target.host !== undefined && target.host.toLowerCase() !== github.api.host)
        return yield* failure(operation, `Signalbox can't reach ${target.host} from the cloud.`, 0);
      const token = yield* connection.accessToken.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failure(operation, `Couldn't read the GitHub connection: ${cause.message}`),
            ),
        }),
      );
      if (token === null)
        return yield* failure(operation, "GitHub isn't connected; connect it in Settings.", 401);
      return token;
    });

  /** One GraphQL read as `token`, decoded; an answer it can't decode fails. */
  const query = <A>(
    operation: string,
    token: string,
    document: string,
    variables: Readonly<Record<string, unknown>>,
    decode: (text: string) => Option.Option<A>,
  ) =>
    github.api.graphql(operation, token, document, variables).pipe(
      Effect.flatMap((text) => {
        const decoded = text === null ? Option.none<A>() : decode(text);
        return Option.isNone(decoded)
          ? Effect.fail(unreadable(operation))
          : Effect.succeed(decoded.value);
      }),
    );

  /** The pull request from one read of `document`; a missing one fails. */
  const pullRequestOf = <A>(
    operation: string,
    token: string,
    target: PullRequestTarget,
    document: string,
    decode: (text: string) => Option.Option<{
      readonly data: { readonly repository: { readonly pullRequest: A | null } | null };
    }>,
    variables: Readonly<Record<string, unknown>> = {},
  ) =>
    query(
      operation,
      token,
      document,
      { ...ownerAndName(target.repository), number: target.number, ...variables },
      decode,
    ).pipe(
      Effect.flatMap((answer) => {
        const pullRequest = answer.data.repository?.pullRequest ?? null;
        return pullRequest === null
          ? Effect.fail(
              failure(operation, `${target.repository}#${target.number} isn't on GitHub.`, 404),
            )
          : Effect.succeed(pullRequest);
      }),
    );

  const evidence = Effect.fn("PullRequestMerges.evidence")(function* (target: PullRequestTarget) {
    const token = yield* tokenFor("mergeEvidence", target);
    /** The first page with the rest of the evidence, then the files' later pages of the same head. */
    const withFiles = Effect.gen(function* () {
      const pullRequest = yield* pullRequestOf(
        "mergeEvidence",
        token,
        target,
        EVIDENCE_QUERY,
        decodeEvidence,
      );
      const files = (pullRequest.files?.nodes ?? []).map((file) => file.path);
      let page = pullRequest.files?.pageInfo ?? null;
      for (let read = 1; read < FILE_PAGES && page?.hasNextPage && page.endCursor; read += 1) {
        const next = yield* pullRequestOf("mergeFiles", token, target, FILES_QUERY, decodeFiles, {
          after: page.endCursor,
        });
        // A page of a newer head would mix two commits' files; leave the list unknown.
        if (next.headRefOid !== pullRequest.headRefOid) {
          page = null;
          break;
        }
        files.push(...(next.files?.nodes ?? []).map((file) => file.path));
        page = next.files?.pageInfo ?? null;
      }
      return { pullRequest, files: page !== null && !page.hasNextPage ? files : null };
    });
    const [{ pullRequest, files }, checks] = yield* Effect.all(
      [withFiles, pullRequestChecksAtHead(github.api, token, target.repository, target.number)],
      { concurrency: 2 },
    );
    const threads = pullRequest.reviewThreads;
    return {
      title: pullRequest.title,
      state: STATES[pullRequest.state] ?? "open",
      headSha: pullRequest.headRefOid,
      isDraft: pullRequest.isDraft,
      mergeability: MERGEABILITY[pullRequest.mergeable],
      reviewDecision:
        pullRequest.reviewDecision === null ? null : DECISIONS[pullRequest.reviewDecision],
      // Checks of another commit (it moved between the reads) are no evidence about this one.
      checks: checks?.headSha === pullRequest.headRefOid ? checks.checks : null,
      openThreads: threads.pageInfo.hasNextPage
        ? null
        : threads.nodes.filter((thread) => !thread.isResolved).length,
      files,
    } satisfies MergeEvidence;
  });

  const branchOf = (operation: string, token: string, target: PullRequestTarget) =>
    pullRequestOf(operation, token, target, PullRequestBranchToDelete.document, decodeBranch);

  const state = Effect.fn("PullRequestMerges.state")(function* (target: PullRequestTarget) {
    const token = yield* tokenFor("pullRequestState", target);
    const branch = yield* branchOf("pullRequestState", token, target);
    return STATES[branch.state] ?? "open";
  });

  const merge = Effect.fn("PullRequestMerges.merge")(function* (
    target: PullRequestTarget,
    input: { readonly headSha?: string; readonly method?: PullRequestMergeMethod },
  ) {
    const token = yield* tokenFor("mergePull", target);
    const answer = yield* github.api
      .mergePull(token, target.repository, target.number, {
        ...(input.headSha === undefined ? {} : { sha: input.headSha }),
        ...(input.method === undefined ? {} : { method: input.method }),
      })
      .pipe(
        // GitHub's "Head branch was modified": the named commit isn't the head anymore.
        Effect.catchIf(
          (error) => error.status === 409 && input.headSha !== undefined,
          () => Effect.succeed("moved" as const),
        ),
      );
    if (answer === "moved") return { _tag: "moved" } satisfies MergeOutcome;
    if (answer === null)
      return yield* failure(
        "mergePull",
        `${target.repository}#${target.number} isn't on GitHub.`,
        404,
      );
    if (!answer.merged) return yield* failure("mergePull", "GitHub didn't merge it.");
    return { _tag: "merged" } satisfies MergeOutcome;
  });

  const deleteBranch = Effect.fn("PullRequestMerges.deleteBranch")(function* (
    target: PullRequestTarget,
  ) {
    const operation = "deletePullRequestBranch";
    const refused = (message: string) => failure(operation, message, 409);
    const token = yield* tokenFor(operation, target);
    const branch = yield* branchOf(operation, token, target);
    if (branch.state === "OPEN")
      return yield* refused("Its branch is deleted only after it merged or closed.");
    const repositoryId = branch.headRepository?.id;
    if (!repositoryId || !branch.headRefName || !branch.headRefOid)
      return yield* refused("Its branch's repository can't be reached.");
    if (branch.headRefName === branch.baseRefName)
      return yield* refused("Its branch is also its base.");
    const ref = `refs/heads/${branch.headRefName}`;
    const source = yield* query(
      operation,
      token,
      PullRequestSourceBranch.document,
      { repositoryId, ref },
      decodeSource,
    );
    const repository = source.data.node;
    if (repository?.__typename !== "Repository")
      return yield* refused("Its branch's repository can't be reached.");
    // Already gone, which is what was asked for.
    if (repository.ref === null) return false;
    if (
      repository.defaultBranchRef === null ||
      repository.defaultBranchRef.name === branch.headRefName
    )
      return yield* refused("Its branch is the repository's default branch.");
    if (repository.ref.target?.oid !== branch.headRefOid)
      return yield* refused("Its branch has commits the pull request doesn't, so it stays.");
    const deleted = yield* query(
      operation,
      token,
      DELETE_BRANCH_MUTATION,
      {
        input: {
          repositoryId,
          refUpdates: [{ name: ref, beforeOid: branch.headRefOid, afterOid: NO_OBJECT }],
        },
      },
      decodeDeleted,
    );
    if (deleted.data?.updateRefs == null)
      return yield* failure(
        operation,
        deleted.errors?.[0]?.message ?? "GitHub didn't delete the branch.",
      );
    return true;
  });

  return PullRequestMerges.of({ evidence, state, merge, deleteBranch });
});

/** In the user's object, beside their GitHub connection. */
export const layer = Layer.effect(PullRequestMerges, make);

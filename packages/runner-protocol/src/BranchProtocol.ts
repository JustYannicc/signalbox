import { PositiveInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's agent publishes its branch (#135): the thread's machine asks
 * the cloud to push the thread's saved branch to the drive's remote, and to
 * open a pull request, the same way the git panel's Push and Create PR do.
 * The machine never holds a credential for the remote: the call carries the
 * thread's drive token (`DriveProtocol.ts`), which names the thread and its
 * drive, and the cloud acts with the thread's owner's own connection. The
 * machine saves the branch first, so the push holds the latest work.
 *
 * `publish` answers 200 with a `PublishResult` whether or not it published:
 * a refusal is an answer for the agent, not a failure to retry.
 */

export const BRANCH_PATHS = {
  publish: `${DRIVE_API_PREFIX}/branch/publish`,
} as const;

/** What to publish: `push` the branch, or `create_pr` to push it and open its pull request. */
export const PublishRequest = Schema.Struct({
  action: Schema.Literals(["push", "create_pr"]),
  /** The pull request's title, body and draft state; the thread's title, a plain body and ready when absent. */
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Boolean),
});
export type PublishRequest = typeof PublishRequest.Type;

/** Why publishing didn't happen. */
export const PublishFailureReason = Schema.Literals([
  /** The thread's owner hasn't connected GitHub, or GitHub no longer honors it. */
  "not_connected",
  /** The owner can't change the drive, or GitHub refused them the repository. */
  "no_permission",
  /** The thread's drive isn't backed by a GitHub repository. */
  "not_a_repository",
  /** The branch on GitHub has commits the thread doesn't. */
  "branch_conflict",
  /** The thread hasn't saved anything to push. */
  "nothing_saved",
  /** GitHub refused the push or pull request for another reason. */
  "rejected",
  /** GitHub or the drive couldn't be reached; trying again later may work. */
  "unavailable",
]);
export type PublishFailureReason = typeof PublishFailureReason.Type;

export const PublishedPullRequest = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  title: Schema.String,
  baseBranch: Schema.String,
  /** False when the branch already had an open pull request. */
  created: Schema.Boolean,
});

export const PublishResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("published"),
    /** The thread's branch on the remote. */
    branch: Schema.String,
    repository: Schema.String,
    /** False when the remote already had the branch at this commit. */
    pushed: Schema.Boolean,
    pullRequest: Schema.NullOr(PublishedPullRequest),
  }),
  Schema.Struct({
    _tag: Schema.Literal("failed"),
    reason: PublishFailureReason,
    message: Schema.String,
  }),
]);
export type PublishResult = typeof PublishResult.Type;

export const branchJson = {
  publishRequest: jsonCodec(PublishRequest),
  publish: jsonCodec(PublishResult),
};

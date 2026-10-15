import type { PullRequestCheck, PullRequestComment, PullRequestRef } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Pull request details events carry beyond the synced summary, read from the
 * host's pull request service (the server's lives in pullRequestReads.ts).
 */

/** A comment or review, as the event carries it. */
export interface Remark {
  readonly id: string;
  readonly kind: PullRequestComment["kind"];
  readonly author: string | null;
  readonly body: string | null;
  readonly path: string | null;
  readonly reviewState: string | null;
  readonly url: string | null;
  readonly at: string;
}

export interface FailedCheck {
  readonly name: string;
  readonly status: PullRequestCheck["status"];
  readonly url: string | null;
}

export interface PullRequestReads {
  /** Remarks by others than the account Signalbox reads with, active after `since`, oldest first. */
  readonly remarksSince: (
    ref: PullRequestRef,
    since: string,
  ) => Effect.Effect<ReadonlyArray<Remark> | null>;
  readonly failedChecks: (ref: PullRequestRef) => Effect.Effect<ReadonlyArray<FailedCheck> | null>;
}

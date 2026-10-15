import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestRef,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { evaluatePullRequestWatch } from "../../orchestration-v2/pullRequestWatch.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import { cap, SHORT_TEXT } from "./candidate.ts";

/**
 * Host reads behind `pr.commented`, `pr.reviewed` and the failed checks on
 * `pr.checks.failed`. Upstream's sync only carries a pull request's summary,
 * so these read its detail and conversation through the same pull request
 * service every other surface uses, and judge them with upstream's own watch
 * rules (`evaluatePullRequestWatch`): a check counts as failed and a remark as
 * new exactly as upstream's PR watch decides. They run only when a sync moved
 * the pull request and something listens, never on a timer of their own. A
 * read that fails or takes too long answers null, so the event still goes,
 * without the details.
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

/** Event delivery waits on these reads, so a slow host only costs the details. */
const READ_TIMEOUT = "20 seconds";
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Review thread pages read per thread before giving up on its tail. */
const PAGE_LIMIT = 10;

/** A watch that has told nothing since `since`, for upstream's evaluation. */
const untoldSince = (since: string): ThreadPullRequestWatch => ({
  startedAt: since,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: since,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
});

/** Hidden markup bots leave in comments isn't worth an agent's attention. */
const visibleText = (body: string) =>
  body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const toRemark = (remark: PullRequestComment): Remark => ({
  id: remark.id,
  kind: remark.kind,
  author: remark.author?.login ?? null,
  body: cap(visibleText(remark.body), SHORT_TEXT),
  path: remark.path,
  reviewState: remark.reviewState,
  url: remark.url,
  at: remark.editedAt ?? remark.createdAt,
});

export const make = (service: PullRequestService.PullRequestService["Service"]) => {
  const quietly =
    (what: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.timeoutOption(READ_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Automation pull request ${what} read failed`, { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );

  const detail = (ref: PullRequestRef) => service.detail({ ...ref, allowStale: false });

  /**
   * Every remark the conversation holds, or null when part of it couldn't be
   * read. Line comments are among the activity's own comments; a long review
   * thread's later pages are read here, as upstream's watch does.
   */
  const conversation = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const activity = yield* service.activity(ref);
      if (activity.commentsTruncated && activity.reviewThreadsTruncated !== false) return null;
      const remarks: PullRequestComment[] = [...activity.comments];
      for (const thread of activity.reviewThreads) {
        let cursor = thread.nextCommentsCursor ?? null;
        const seen = new Set<string>();
        for (let page = 0; cursor !== null; page += 1) {
          // A cursor seen twice, or a thread too long to read, would leave remarks out.
          if (seen.has(cursor) || page >= PAGE_LIMIT) return null;
          seen.add(cursor);
          const next = yield* service.threadComments({ ...ref, threadId: thread.id, cursor });
          for (const comment of next.comments) {
            remarks.push({
              ...comment,
              kind: "review-comment",
              path: thread.path,
              reviewState: null,
            });
          }
          cursor = next.nextCursor;
        }
      }
      return remarks;
    });

  const reads: PullRequestReads = {
    remarksSince: (ref, since) =>
      Effect.gen(function* () {
        // The sync just saw the pull request move, so a cached answer may predate it.
        yield* service.invalidate({ reference: ref }, { notifyReaders: false });
        const [current, remarks] = yield* Effect.all([detail(ref), conversation(ref)], {
          concurrency: 2,
        });
        if (remarks === null) return null;
        const report = evaluatePullRequestWatch(untoldSince(since), current, remarks);
        // Strictly after: a remark at `since` itself moved the previous sync and was told then.
        const after = Date.parse(since);
        return report.changes
          .flatMap((change) => (change.kind === "remarks" ? change.remarks : []))
          .map(toRemark)
          .filter((remark) => Date.parse(remark.at) > after)
          .toSorted((left, right) => left.at.localeCompare(right.at));
      }).pipe(quietly("conversation")),
    failedChecks: (ref) =>
      detail(ref).pipe(
        Effect.map((current) =>
          evaluatePullRequestWatch(untoldSince(EPOCH), current, []).changes.flatMap((change) =>
            change.kind === "checks-failed"
              ? change.failed.map((check) => ({
                  name: check.name,
                  status: check.status,
                  url: check.url,
                }))
              : [],
          ),
        ),
        quietly("checks"),
      ),
  };
  return reads;
};

/**
 * Hands the engine the reads; the engine itself can't depend on the pull
 * request service. Servers built without one (tests) go without the details.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const service = yield* Effect.serviceOption(PullRequestService.PullRequestService);
    if (Option.isSome(service)) yield* engine.registerPullRequestReads(make(service.value));
  }),
);

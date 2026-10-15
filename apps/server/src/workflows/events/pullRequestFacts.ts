import type {
  AutomationEventName,
  OrchestrationV2AppThread,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

import { fixed, type Candidate, type EventReads } from "./candidate.ts";
import type { Remark } from "./pullRequestReads.ts";

/**
 * Pull request facts as events. Upstream's sync reactor keeps each thread's
 * linked pull requests' host state on the thread and announces every change
 * as `thread.pull-request-synced`; this turns those snapshots into `pr.*`
 * events on the transitions automations care about. No polling of its own.
 *
 * The last snapshot per thread and pull request lives in memory. After a
 * restart the first snapshot seen has no "before": it counts as a transition
 * only when it was synced after this process started, so a merge the server
 * slept through still arrives once, while state that was already true before
 * the restart doesn't repeat. A transition missed entirely while down (a
 * check that went red and green again) is lost, like any live-tail event.
 *
 * Comments and reviews aren't in the snapshot, but a new one moves the pull
 * request's `updatedAt`. When it moves, `pr.commented` and `pr.reviewed` read
 * the conversation for remarks newer than the previous `updatedAt`, and only
 * when something listens (see pullRequestReads.ts). One event carries every
 * remark of its kind since the last sync, so a burst of comments wakes once.
 */

/** The `pr.*` events derived here, so a test can hold the normalizer to the catalog. */
export const PULL_REQUEST_FACT_EVENTS = [
  "pr.merged",
  "pr.closed",
  "pr.checks.passed",
  "pr.checks.failed",
  "pr.conflicted",
] as const satisfies ReadonlyArray<AutomationEventName>;

export const PULL_REQUEST_REMARK_EVENTS = [
  "pr.commented",
  "pr.reviewed",
] as const satisfies ReadonlyArray<AutomationEventName>;

type Link = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "snapshot" | "watch"
>;

/** One pull request's synced facts; null fields until the first sync. */
export const pullRequestFacts = (link: Link) => {
  const snapshot = link.snapshot;
  return {
    repository: link.repository,
    number: link.number,
    url: link.url,
    title: snapshot?.title ?? null,
    state: snapshot?.state ?? null,
    isDraft: snapshot?.isDraft ?? null,
    checksState: snapshot?.checksState ?? null,
    mergeability: snapshot?.mergeability ?? null,
    reviewDecision: snapshot?.reviewDecision ?? null,
    headBranch: snapshot?.headBranch ?? null,
    baseBranch: snapshot?.baseBranch ?? null,
    headSha: link.watch?.headSha ?? null,
  };
};

type Snapshot = Pick<
  ThreadPullRequestSnapshot,
  "state" | "checksState" | "mergeability" | "updatedAt"
>;

/** Which facts became true between `before` (undefined after a restart) and `now`. */
function transitions(
  before: Snapshot | undefined,
  now: ThreadPullRequestSnapshot,
  fresh: boolean,
): ReadonlyArray<(typeof PULL_REQUEST_FACT_EVENTS)[number]> {
  const became = <K extends keyof Snapshot>(field: K, value: Snapshot[K]) =>
    now[field] === value && (before ? before[field] !== value : fresh);
  return [
    ...(became("state", "merged") ? (["pr.merged"] as const) : []),
    ...(became("state", "closed") ? (["pr.closed"] as const) : []),
    ...(became("checksState", "passing") ? (["pr.checks.passed"] as const) : []),
    ...(became("checksState", "failing") ? (["pr.checks.failed"] as const) : []),
    ...(became("mergeability", "conflicting") ? (["pr.conflicted"] as const) : []),
  ];
}

/**
 * Tracks pull request snapshots per thread. `observe` takes every
 * `thread.pull-request-synced` (even when nobody listens, so "before" stays
 * right) and returns the derived events; `forget` drops a deleted thread.
 */
export function makePullRequestTracker(startedAtMs: number) {
  const threads = new Map<string, Map<string, Snapshot>>();

  const observe = (event: {
    readonly threadId: string;
    readonly payload: OrchestrationV2AppThread;
  }): ReadonlyArray<Candidate> => {
    const thread = event.payload;
    const before = threads.get(event.threadId);
    const next = new Map<string, Snapshot>();
    const candidates: Candidate[] = [];
    for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
      const snapshot = link.snapshot;
      if (snapshot === null) continue;
      const key = threadPullRequestKeyOf(link);
      next.set(key, {
        state: snapshot.state,
        checksState: snapshot.checksState,
        mergeability: snapshot.mergeability,
        updatedAt: snapshot.updatedAt,
      });
      const ref = {
        projectId: thread.projectId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      };
      const previous = before?.get(key);
      const fresh = Date.parse(snapshot.syncedAt) >= startedAtMs;
      for (const name of transitions(previous, snapshot, fresh)) {
        const terminal = name === "pr.merged" || name === "pr.closed";
        candidates.push({
          name,
          // A merge happens once; checks and conflicts can flip back and forth, one id per sync.
          id: `${name}:${event.threadId}:${key}${terminal ? "" : `:${snapshot.syncedAt}`}`,
          projectId: thread.projectId,
          build:
            name === "pr.checks.failed"
              ? (reads) =>
                  (reads.pullRequests?.failedChecks(ref) ?? Effect.succeed(null)).pipe(
                    Effect.map((failedChecks) => ({ ...pullRequestFacts(link), failedChecks })),
                  )
              : fixed(() => pullRequestFacts(link)),
        });
      }
      // A remark moves `updatedAt`; without a "before" there's nothing to read since.
      const since = previous?.updatedAt;
      if (since && snapshot.updatedAt && snapshot.updatedAt !== since) {
        // Both kinds share one read per sync, made only if one of them is built (one at a time).
        let read: ReadonlyArray<Remark> | null | undefined;
        const remarksOf = (reads: EventReads) =>
          read !== undefined
            ? Effect.succeed(read)
            : (reads.pullRequests?.remarksSince(ref, since) ?? Effect.succeed(null)).pipe(
                Effect.tap((remarks) =>
                  Effect.sync(() => {
                    read = remarks;
                  }),
                ),
              );
        for (const name of PULL_REQUEST_REMARK_EVENTS) {
          candidates.push({
            name,
            id: `${name}:${event.threadId}:${key}:${snapshot.updatedAt}`,
            projectId: thread.projectId,
            build: (reads) =>
              remarksOf(reads).pipe(
                Effect.map((remarks) => {
                  // Unread: something new happened, so say so once, without the details.
                  if (remarks === null)
                    return name === "pr.commented" ? { ...pullRequestFacts(link), remarks } : null;
                  const mine = remarks.filter((remark) =>
                    name === "pr.reviewed" ? remark.kind === "review" : remark.kind !== "review",
                  );
                  return mine.length === 0 ? null : { ...pullRequestFacts(link), remarks: mine };
                }),
              ),
          });
        }
      }
    }
    if (next.size > 0) threads.set(event.threadId, next);
    else threads.delete(event.threadId);
    return candidates;
  };

  return { observe, forget: (threadId: string) => void threads.delete(threadId) };
}

export type PullRequestTracker = ReturnType<typeof makePullRequestTracker>;

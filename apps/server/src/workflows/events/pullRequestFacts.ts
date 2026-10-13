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

import { fixed, type Candidate } from "./candidate.ts";

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
 */

/** The `pr.*` events derived here, so a test can hold the normalizer to the catalog. */
export const PULL_REQUEST_FACT_EVENTS = [
  "pr.merged",
  "pr.closed",
  "pr.checks.passed",
  "pr.checks.failed",
  "pr.conflicted",
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

type Snapshot = Pick<ThreadPullRequestSnapshot, "state" | "checksState" | "mergeability">;

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
      });
      const fresh = Date.parse(snapshot.syncedAt) >= startedAtMs;
      for (const name of transitions(before?.get(key), snapshot, fresh)) {
        const terminal = name === "pr.merged" || name === "pr.closed";
        candidates.push({
          name,
          // A merge happens once; checks and conflicts can flip back and forth, one id per sync.
          id: `${name}:${event.threadId}:${key}${terminal ? "" : `:${snapshot.syncedAt}`}`,
          projectId: thread.projectId,
          build: fixed(() => pullRequestFacts(link)),
        });
      }
    }
    if (next.size > 0) threads.set(event.threadId, next);
    else threads.delete(event.threadId);
    return candidates;
  };

  return { observe, forget: (threadId: string) => void threads.delete(threadId) };
}

export type PullRequestTracker = ReturnType<typeof makePullRequestTracker>;

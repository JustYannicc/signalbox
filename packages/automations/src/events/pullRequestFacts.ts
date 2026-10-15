import type {
  AutomationEventName,
  OrchestrationV2AppThread,
  ProjectId,
  PullRequestRef,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

import { fixed, type Candidate, type EventReads } from "./candidate.ts";
import type { PullRequestReads, Remark } from "./pullRequestDetails.ts";

/**
 * Pull request facts as events. Upstream's sync reactor keeps each thread's
 * linked pull requests' host state on the thread and announces every change,
 * as `thread.pull-request-synced` for links, unlinks and watches and as
 * `thread.pull-request-link-updated` for its periodic syncs; this turns those
 * snapshots into `pr.*` events on the transitions automations care about.
 * No polling of its own.
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

const snapshotOf = (snapshot: ThreadPullRequestSnapshot): Snapshot => ({
  state: snapshot.state,
  checksState: snapshot.checksState,
  mergeability: snapshot.mergeability,
  updatedAt: snapshot.updatedAt,
});

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

/** The last snapshots of one thread's pull requests, and its project once a full sync named it. */
interface TrackedThread {
  readonly projectId: ProjectId | undefined;
  readonly links: Map<string, Snapshot>;
}

/**
 * Tracks pull request snapshots per thread. `observe` takes every
 * `thread.pull-request-synced` and `observeLink` every
 * `thread.pull-request-link-updated` (even when nobody listens, so "before"
 * stays right) and both return the derived events; `forget` drops a deleted
 * thread. The sync reactor's periodic syncs arrive as link updates, which
 * carry the one link and no project: after a restart, until a full sync
 * names it, the project is read from the thread when someone listens.
 */
export function makePullRequestTracker(startedAtMs: number) {
  const threads = new Map<string, TrackedThread>();

  /** One pull request's derived events against its previous snapshot. */
  const factsOf = (
    threadId: string,
    projectId: ProjectId | undefined,
    link: ThreadPullRequestLink,
    snapshot: ThreadPullRequestSnapshot,
    previous: Snapshot | undefined,
  ): ReadonlyArray<Candidate> => {
    const key = threadPullRequestKeyOf(link);
    const candidates: Candidate[] = [];
    // Unknown, the trigger runtime reads it from the thread when someone listens.
    const where = projectId === undefined ? {} : { projectId };
    /** A host read for this pull request, or null without reads or a project. */
    const readFor = <A>(
      reads: EventReads,
      use: (pullRequests: PullRequestReads, ref: PullRequestRef) => Effect.Effect<A | null>,
    ) =>
      Effect.gen(function* () {
        const project = projectId ?? (yield* reads.shell)?.projectId;
        if (!reads.pullRequests || project === undefined) return null;
        return yield* use(reads.pullRequests, {
          projectId: project,
          host: link.host,
          repository: link.repository,
          number: link.number,
        });
      });
    const fresh = Date.parse(snapshot.syncedAt) >= startedAtMs;
    for (const name of transitions(previous, snapshot, fresh)) {
      const terminal = name === "pr.merged" || name === "pr.closed";
      candidates.push({
        name,
        // A merge happens once; checks and conflicts can flip back and forth, one id per sync.
        id: `${name}:${threadId}:${key}${terminal ? "" : `:${snapshot.syncedAt}`}`,
        ...where,
        build:
          name === "pr.checks.failed"
            ? (reads) =>
                readFor(reads, (pullRequests, ref) => pullRequests.failedChecks(ref)).pipe(
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
          : readFor(reads, (pullRequests, ref) => pullRequests.remarksSince(ref, since)).pipe(
              Effect.tap((remarks) =>
                Effect.sync(() => {
                  read = remarks;
                }),
              ),
            );
      for (const name of PULL_REQUEST_REMARK_EVENTS) {
        candidates.push({
          name,
          id: `${name}:${threadId}:${key}:${snapshot.updatedAt}`,
          ...where,
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
    return candidates;
  };

  const keep = (threadId: string, tracked: TrackedThread) => {
    if (tracked.links.size > 0) threads.set(threadId, tracked);
    else threads.delete(threadId);
  };

  const observe = (event: {
    readonly threadId: string;
    readonly payload: OrchestrationV2AppThread;
  }): ReadonlyArray<Candidate> => {
    const thread = event.payload;
    const before = threads.get(event.threadId)?.links;
    const next = new Map<string, Snapshot>();
    const candidates: Candidate[] = [];
    for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
      const snapshot = link.snapshot;
      if (snapshot === null) continue;
      const key = threadPullRequestKeyOf(link);
      next.set(key, snapshotOf(snapshot));
      candidates.push(
        ...factsOf(event.threadId, thread.projectId, link, snapshot, before?.get(key)),
      );
    }
    keep(event.threadId, { projectId: thread.projectId, links: next });
    return candidates;
  };

  const observeLink = (event: {
    readonly threadId: string;
    readonly payload: ThreadPullRequestLink;
  }): ReadonlyArray<Candidate> => {
    const link = event.payload;
    const tracked = threads.get(event.threadId) ?? { projectId: undefined, links: new Map() };
    const key = threadPullRequestKeyOf(link);
    const previous = tracked.links.get(key);
    const snapshot = link.snapshot;
    if (snapshot === null || visibleThreadPullRequests([link]).length === 0) {
      tracked.links.delete(key);
      keep(event.threadId, tracked);
      return [];
    }
    tracked.links.set(key, snapshotOf(snapshot));
    keep(event.threadId, tracked);
    return factsOf(event.threadId, tracked.projectId, link, snapshot, previous);
  };

  return { observe, observeLink, forget: (threadId: string) => void threads.delete(threadId) };
}

export type PullRequestTracker = ReturnType<typeof makePullRequestTracker>;

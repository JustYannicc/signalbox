import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import { type DecisionContext, threadEvent } from "../threadEvents.ts";

/**
 * A cloud thread's pull request links: `thread.pull-request.link`, `.unlink`
 * and `thread.pull-request-link.sync`, decided the way upstream's orchestrator
 * decides them (`apps/server/src/orchestration-v2/Orchestrator.ts`), so links
 * look the same on every client. Watches aren't served here yet.
 *
 * Every change goes out as `thread.pull-request-synced` with the whole thread,
 * syncs included: upstream sends a sync as `thread.pull-request-link-updated`
 * with just the link, but automations derive `pr.*` facts from
 * `thread.pull-request-synced` (`workflows/events/pullRequestFacts.ts`), and a
 * cloud thread has few links, so the whole thread costs nothing.
 */

export type PullRequestLinkCommand = Extract<
  OrchestrationV2Command,
  {
    readonly type:
      | "thread.pull-request.link"
      | "thread.pull-request.unlink"
      | "thread.pull-request-link.sync";
  }
>;

export type SnapshotFields = Omit<ThreadPullRequestSnapshot, "syncedAt">;

/** Upstream's sync reactor's comparison: `syncedAt` alone never makes a change. */
export function snapshotFieldsEqual(left: SnapshotFields, right: SnapshotFields): boolean {
  return (
    left.state === right.state &&
    left.title === right.title &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.isDraft === right.isDraft &&
    left.updatedAt === right.updatedAt &&
    (left.closedAt ?? null) === (right.closedAt ?? null) &&
    (left.mergedAt ?? null) === (right.mergedAt ?? null) &&
    (left.author?.login ?? null) === (right.author?.login ?? null) &&
    (left.author?.avatarUrl ?? null) === (right.author?.avatarUrl ?? null) &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.changedFiles === right.changedFiles &&
    (left.reviewDecision ?? null) === (right.reviewDecision ?? null) &&
    (left.checksState ?? null) === (right.checksState ?? null) &&
    left.mergeability === right.mergeability
  );
}

function stacksEqual(left: ThreadPullRequestStack | null, right: ThreadPullRequestStack | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const freshLink = (
  key: ReturnType<typeof normalizeThreadPullRequestKey>,
  url: string,
  source: ThreadPullRequestLink["source"],
  ctx: DecisionContext,
): ThreadPullRequestLink => ({
  ...key,
  url,
  source,
  linkedAt: DateTime.formatIso(ctx.now),
  snapshot: null,
  stack: null,
});

/** The thread with its links after `command`; the same thread when nothing changes. */
function nextThread(
  thread: OrchestrationV2AppThread,
  command: PullRequestLinkCommand,
  ctx: DecisionContext,
): OrchestrationV2AppThread {
  const key = normalizeThreadPullRequestKey(command);
  const links = threadPullRequestsOf(thread);
  const existing = links.find((link) => threadPullRequestKeysEqual(link, key));
  let pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  if (command.type === "thread.pull-request.link") {
    const undismisses =
      existing?.source === "stack-dismissed" &&
      command.source !== "stack" &&
      command.source !== "stack-dismissed";
    if (existing && !undismisses) return thread;
    const link = existing
      ? { ...existing, source: command.source, url: command.url }
      : freshLink(key, command.url, command.source, ctx);
    const branch = thread.branchPullRequest;
    const branchKey = branch ? legacyThreadPullRequestKey(branch) : null;
    pullRequests = [
      // A manual link beside the branch's own pull request keeps that one too.
      ...(command.source === "manual" &&
      branch &&
      branchKey &&
      visibleThreadPullRequests(links).length === 0 &&
      !threadPullRequestKeysEqual(branchKey, key) &&
      !links.some((entry) => threadPullRequestKeysEqual(entry, branchKey))
        ? [freshLink(branchKey, branch.url, "manual", ctx)]
        : []),
      ...links.filter((entry) => !threadPullRequestKeysEqual(entry, key)),
      link,
    ];
  } else if (command.type === "thread.pull-request.unlink") {
    if (!existing) return thread;
    const belongsToStack =
      existing.source === "stack" ||
      existing.stack !== null ||
      links.some(
        (link) =>
          link.host.toLowerCase() === key.host &&
          link.repository.toLowerCase() === key.repository &&
          link.stack?.layers.some((layer) => layer.number === key.number),
      );
    pullRequests = belongsToStack
      ? links.map((link) =>
          link === existing ? { ...link, source: "stack-dismissed" as const } : link,
        )
      : links.filter((link) => link !== existing);
  } else {
    if (!existing) return thread;
    // Unchanged host state is no news: only `syncedAt` would move.
    if (
      existing.snapshot !== null &&
      snapshotFieldsEqual(existing.snapshot, command.snapshot) &&
      stacksEqual(existing.stack, command.stack)
    ) {
      return thread;
    }
    pullRequests = links.map((link) =>
      link === existing ? { ...link, snapshot: command.snapshot, stack: command.stack } : link,
    );
  }
  const linked = thread.linkedPullRequest;
  return {
    ...thread,
    pullRequests,
    linkedPullRequest:
      linked &&
      pullRequests.some(
        (link) =>
          link.source !== "stack-dismissed" &&
          threadPullRequestKeysEqual(link, legacyThreadPullRequestKey(linked)),
      )
        ? linked
        : null,
    // Syncing is the host's news, not activity on the thread.
    updatedAt: command.type === "thread.pull-request-link.sync" ? thread.updatedAt : ctx.now,
  };
}

/** The events `command` decides on `projection`: none when it changes nothing. */
export function pullRequestLinkEvents(
  projection: OrchestrationV2ThreadProjection,
  command: PullRequestLinkCommand,
  ctx: DecisionContext,
) {
  const thread = nextThread(projection.thread, command, ctx);
  return thread === projection.thread
    ? []
    : [threadEvent(ctx, "thread.pull-request-synced", thread)];
}

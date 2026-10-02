/**
 * Home reads statuses from the shared `threadStatusDisplay` vocabulary (the
 * Pipeline's). Real threads resolve with the Pipeline's own rules; fixtures
 * carry a status directly. Folder rows stay calm: they only summarize what
 * needs you (Failed included), never passive progress.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../../Sidebar.logic";
import {
  THREAD_STATUS_DISPLAY,
  resolveThreadDisplayStatus,
  threadHasPlanReady,
  type ThreadDisplayStatus,
} from "../../threadStatusDisplay";

export type { ThreadDisplayStatus as HomeItemStatus } from "../../threadStatusDisplay";

function isWoke(thread: EnvironmentThreadShell, lastVisitedAt: string | undefined): boolean {
  const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
  if (wokeAt === null || thread.settledOverride === "settled") return false;
  const woke = Date.parse(wokeAt);
  const visited = lastVisitedAt === undefined ? Number.NaN : Date.parse(lastVisitedAt);
  return Number.isNaN(visited) || visited < woke;
}

/** The Pipeline's status for a real thread. */
export function statusForThread(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
): ThreadDisplayStatus | null {
  return resolveThreadDisplayStatus({
    status: resolveSidebarThreadStatus(thread),
    planReady: threadHasPlanReady(thread),
    isWoke: isWoke(thread, lastVisitedAt),
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
}

export interface StatusRollup {
  /** Items waiting on you: approval, input, plan, failed, woke, or an @mention. */
  readonly needsYou: number;
  /** The most urgent of those, for the icon. */
  readonly mostUrgent: ThreadDisplayStatus | null;
}

export interface RollupInput {
  readonly status: ThreadDisplayStatus | null;
  readonly mentioned?: boolean;
}

function moreUrgent(left: ThreadDisplayStatus | null, right: ThreadDisplayStatus | null) {
  if (left === null) return right;
  if (right === null) return left;
  return THREAD_STATUS_DISPLAY[right].priority > THREAD_STATUS_DISPLAY[left].priority
    ? right
    : left;
}

export function rollupOf(items: Iterable<RollupInput>): StatusRollup {
  let needsYou = 0;
  let mostUrgent: ThreadDisplayStatus | null = null;
  for (const item of items) {
    const statusNeedsYou = item.status !== null && THREAD_STATUS_DISPLAY[item.status].needsYou;
    if (!statusNeedsYou && !item.mentioned) continue;
    needsYou += 1;
    if (statusNeedsYou) mostUrgent = moreUrgent(mostUrgent, item.status);
  }
  return { needsYou, mostUrgent };
}

export function mergeRollups(rollups: Iterable<StatusRollup>): StatusRollup {
  let needsYou = 0;
  let mostUrgent: ThreadDisplayStatus | null = null;
  for (const rollup of rollups) {
    needsYou += rollup.needsYou;
    mostUrgent = moreUrgent(mostUrgent, rollup.mostUrgent);
  }
  return { needsYou, mostUrgent };
}

export function rollupForThreads(
  threads: readonly EnvironmentThreadShell[],
  lastVisitedAtByKey: Readonly<Record<string, string>>,
  threadKey: (thread: EnvironmentThreadShell) => string,
): StatusRollup {
  return rollupOf(
    threads.map((thread) => ({
      status: statusForThread(thread, lastVisitedAtByKey[threadKey(thread)]),
    })),
  );
}

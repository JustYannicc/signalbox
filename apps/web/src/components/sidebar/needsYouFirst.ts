/**
 * signalbox: a thread waiting on the person ranks first in its list, so a
 * question, an approval or an unseen failure never sits under "Show more"
 * behind newer threads that are only working. Within each group the list
 * keeps its own order.
 */
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreads } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";
import { hasUnseenCompletion } from "../Sidebar.logic";

/** Waiting on the person: a question or approval (its own or a subagent's), or a failure not yet seen. */
export function threadNeedsYou(thread: SidebarThreadSummary): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.latestRun?.status === "failed" && hasUnseenCompletion(thread))
  );
}

export function sortThreadsNeedsYouFirst<T extends SidebarThreadSummary>(
  threads: ReadonlyArray<T>,
  order: SidebarThreadSortOrder,
): T[] {
  const sorted = sortThreads(threads, order);
  const first = sorted.filter(threadNeedsYou);
  return first.length === 0 ? sorted : [...first, ...sorted.filter((t) => !threadNeedsYou(t))];
}

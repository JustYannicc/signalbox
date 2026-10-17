/**
 * signalbox: a failed run reads as Failed, not Completed, until the person has
 * looked at it. Sidebar.logic's status pill hooks in here.
 */
import type { SidebarThreadSummary } from "../../types";

/**
 * A failed latest run the person hasn't looked at since it ended. Unlike a
 * completion, a thread nobody has opened yet (an automation's, say) counts:
 * its failure still needs someone.
 */
export function hasUnseenFailure(
  thread: Pick<SidebarThreadSummary, "latestRun"> & { lastVisitedAt?: string | null | undefined },
): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

// Typed where Sidebar.logic returns it; importing its pill type here would be a cycle.
export const FAILED_STATUS_PILL = {
  label: "Failed" as const,
  colorClass: "text-red-600 dark:text-red-300/90",
  dotClass: "bg-red-500 dark:bg-red-300/90",
  pulse: false,
};

import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";

/**
 * signalbox: whether the timeline already shows `error` as the latest run's
 * failure row, which carries the cause. The thread's error banner then stays
 * away, so a failure is said once. Errors the timeline doesn't hold, such as a
 * send the server refused, still get the banner.
 */
export function failureShownInTimeline(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  latestRunId: RunId | null | undefined,
  error: string | null,
): boolean {
  if (error === null || latestRunId == null) return false;
  return turnItems.some(
    (item) =>
      item.type === "error" &&
      item.status === "failed" &&
      item.runId === latestRunId &&
      item.failure.message === error,
  );
}

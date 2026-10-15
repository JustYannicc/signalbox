import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** How a thread's run ended, once it has. */
export type TerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

const TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export const isTerminalRunStatus = (
  status: OrchestrationV2Run["status"],
): status is TerminalRunStatus => TERMINAL.has(status);

/** The thread's newest run. */
export const latestRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined =>
  projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];

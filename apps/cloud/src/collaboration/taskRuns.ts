import {
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";

import { isTerminalRunStatus } from "../thread/runLifecycle.ts";
import { runContinuationChain } from "../thread/runContinuations.ts";

type TaskRunState = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "status" | "restartContinuationOfRunId"
>;

/** A continuation supersedes its interrupted predecessor as the task's result. */
export const latestTaskTerminalRun = <Run extends TaskRunState>(
  runs: ReadonlyArray<Run>,
): Run | undefined => {
  const continuedRunIds = new Set(
    runs.flatMap((run) =>
      run.restartContinuationOfRunId === undefined ? [] : [run.restartContinuationOfRunId],
    ),
  );
  return runs
    .filter((run) => isTerminalRunStatus(run.status) && !continuedRunIds.has(run.id))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
};

/** Recovery continuations remain part of the original task's run, not follow-up work. */
export const hasPendingTaskRuns = <Run extends TaskRunState>(
  runs: ReadonlyArray<Run>,
  originalRunOrId: Run | string | null | undefined,
): boolean => {
  const taskRunIds = new Set(runContinuationChain(runs, originalRunOrId).map((run) => run.id));
  return runs.some(
    (run) =>
      !taskRunIds.has(run.id) &&
      (run.status === "queued" ||
        run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting"),
  );
};

export const taskResult = (
  projection: OrchestrationV2ThreadProjection,
): OrchestratorMcpDelegateTaskResult => {
  const { thread } = projection;
  const originalRun = projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0];
  const runChain = runContinuationChain(projection.runs, originalRun);
  const run = runChain.at(-1);
  const latest = latestTaskTerminalRun(projection.runs);
  const summaryOf = (runId: string | undefined) => {
    const messages = projection.messages.filter(
      (message) => message.runId === runId && message.role === "assistant" && !message.streaming,
    );
    const error = projection.turnItems.find(
      (item) => item.runId === runId && item.type === "error",
    );
    return messages.at(-1)?.text ?? (error?.type === "error" ? error.failure.message : null);
  };
  const statusOf = (status: OrchestrationV2Run["status"]) =>
    status === "preparing" || status === "starting"
      ? ("running" as const)
      : status === "rolled_back"
        ? ("interrupted" as const)
        : status;
  const status = run === undefined ? "queued" : statusOf(run.status);
  const terminal = isTerminalRunStatus(status);
  return {
    taskId: NodeId.make(`cloud-task:${thread.id}`),
    childThreadId: thread.id,
    childRunId: originalRun?.id ?? null,
    childNodeId: originalRun?.rootNodeId ?? NodeId.make(`node:${thread.id}:pending`),
    status,
    workState: terminal ? "result_available" : "working",
    hasPendingChildRuns: hasPendingTaskRuns(projection.runs, originalRun),
    latestTerminalRunId: latest?.id ?? null,
    latestTerminalStatus:
      latest === undefined
        ? null
        : (statusOf(latest.status) as OrchestratorMcpDelegateTaskResult["latestTerminalStatus"]),
    latestTerminalSummary: latest === undefined ? null : summaryOf(latest.id),
    latestTerminalResultContextTransferId: null,
    providerInstanceId: originalRun?.providerInstanceId ?? thread.providerInstanceId,
    model: originalRun?.modelSelection.model ?? thread.modelSelection.model,
    summary: terminal ? summaryOf(run?.id) : null,
    resultContextTransferId: null,
    hasPendingQuestion: projection.runtimeRequests.some((request) => request.status === "pending"),
    waitTimedOut: false,
  };
};

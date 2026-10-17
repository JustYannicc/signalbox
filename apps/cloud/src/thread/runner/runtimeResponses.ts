import type { RunnerRuntimeResponse } from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** Resolved requests are the outbox: a reconnect reads the same committed answers again. */
export const runtimeResponsesOf = (
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): ReadonlyArray<RunnerRuntimeResponse> => {
  if (run.status !== "running") return [];
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  return projection.runtimeRequests.flatMap((request) => {
    if (
      request.status !== "resolved" ||
      request.resolvedAt === null ||
      request.responseCapability.type !== "live" ||
      request.responseCapability.providerSessionId !== providerThread?.providerSessionId ||
      request.providerTurnId === null ||
      (request.kind === "user_input"
        ? request.answers === undefined || request.decision !== undefined
        : request.decision === undefined || request.answers !== undefined) ||
      !projection.providerTurns.some(
        (turn) =>
          turn.id === request.providerTurnId &&
          turn.runAttemptId === run.activeAttemptId &&
          turn.providerThreadId === run.providerThreadId &&
          turn.status === "running",
      )
    ) {
      return [];
    }
    return [
      {
        runId: run.id,
        requestId: request.id,
        providerSessionId: request.responseCapability.providerSessionId,
        providerTurnId: request.providerTurnId,
        ...(request.answers === undefined ? {} : { answers: request.answers }),
        ...(request.decision === undefined ? {} : { decision: request.decision }),
      },
    ];
  });
};

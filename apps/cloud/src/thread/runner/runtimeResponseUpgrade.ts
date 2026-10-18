import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import type { MachineLease } from "../ThreadStore.ts";
import { awaitsHandoff } from "./runnerTurn.ts";
import { runnerCapabilityUpgrade } from "./runnerCapabilityUpgrade.ts";

/** A warm Runner needs updating only when this turn can use a native callback. */
export function needsRuntimeResponses(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
) {
  return (
    (awaitsHandoff(run) &&
      (projection.thread.runtimeMode !== "full-access" ||
        projection.thread.interactionMode === "plan")) ||
    projection.runtimeRequests.some(
      (request) =>
        request.responseCapability.type === "live" &&
        (request.status === "pending" || request.status === "resolved") &&
        projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
    )
  );
}

/** One in-place update per lease chain; a still-old image waits visibly instead of looping. */
export function runtimeResponseUpgrade(
  lease: MachineLease,
  projection: OrchestrationV2ThreadProjection | null,
  run: OrchestrationV2Run | undefined,
  now: number,
  drainTimeoutMs: number,
) {
  return runnerCapabilityUpgrade(
    lease,
    projection !== null && run !== undefined && needsRuntimeResponses(projection, run),
    lease.runtimeResponses === true,
    lease.runtimeResponsesUpgrade === true,
    now,
    drainTimeoutMs,
  );
}

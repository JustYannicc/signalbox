import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import type { MachineLease } from "../ThreadStore.ts";
import { awaitsHandoff } from "./runnerTurn.ts";
import { isCloudApprovalRequest } from "../runtimeRequests.ts";

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
        !isCloudApprovalRequest(projection, request) &&
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
  if (
    lease.status !== "connected" ||
    lease.disconnectedAt !== null ||
    lease.runtimeResponses === true ||
    projection === null ||
    run === undefined ||
    !needsRuntimeResponses(projection, run)
  )
    return { type: "none" } as const;
  if (lease.runtimeResponsesUpgrade === true) return { type: "blocked" } as const;
  if (lease.drains !== true) return { type: "replace" } as const;
  if (lease.drain === undefined) return { type: "drain" } as const;
  if (lease.drain._tag === "answered") return { type: "replace" } as const;
  const deadline = lease.drain.id + drainTimeoutMs;
  return now >= deadline ? ({ type: "replace" } as const) : ({ type: "wait", deadline } as const);
}

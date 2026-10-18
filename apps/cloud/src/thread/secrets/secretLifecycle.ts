import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";

import { runEvent, turnItemEvent, type DecisionContext } from "../threadEvents.ts";

type Projection = OrchestrationV2ThreadProjection;
type SecretItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;

/** Settle cards against custody under the engine's commit lock, without an HTTP waiter. */
export function settleSecretRequests(
  previous: Projection | null,
  projection: Projection,
  usableRequests: ReadonlySet<string>,
  ctx: DecisionContext,
) {
  const changed: Array<SecretItem> = [];
  for (const item of projection.turnItems) {
    if (item.type !== "secret_request") continue;
    const prior = previous?.turnItems.find((candidate) => candidate.id === item.id);
    // Recovery or a delayed provider row cannot reopen a terminal private card.
    if (prior?.type === "secret_request" && prior.secretStatus !== "pending") {
      if (prior.secretStatus !== item.secretStatus || prior.status !== item.status)
        changed.push(prior);
    } else if (item.secretStatus === "pending" && !usableRequests.has(item.id)) {
      changed.push({
        ...item,
        secretStatus: "cancelled",
        status: "cancelled",
        completedAt: ctx.now,
        updatedAt: ctx.now,
      });
    }
  }
  const settled = projection.turnItems.map(
    (item) => changed.find((next) => next.id === item.id) ?? item,
  );
  return [
    ...changed.map((item) => turnItemEvent(ctx, item)),
    ...projection.runs.flatMap((run) => {
      if (run.status !== "waiting" || !changed.some((item) => item.runId === run.id)) return [];
      const pending =
        settled.some(
          (item) =>
            item.type === "secret_request" &&
            item.runId === run.id &&
            item.secretStatus === "pending",
        ) ||
        projection.runtimeRequests.some(
          (request) =>
            request.status === "pending" &&
            projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
        );
      return pending ? [] : [runEvent(ctx, "run.updated", { ...run, status: "running" })];
    }),
  ];
}

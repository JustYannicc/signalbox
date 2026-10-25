import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** A live callback dies with its turn. Its mirrored ask remains answerable as a message. */
export function expireRuntimeRequests(
  projection: OrchestrationV2ThreadProjection,
  events: readonly OrchestrationV2DomainEvent[],
) {
  const requests = new Map(projection.runtimeRequests.map((entry) => [entry.id, entry]));
  const nodes = new Map(projection.nodes.map((entry) => [entry.id, entry]));
  const items = new Map(projection.turnItems.map((entry) => [entry.id, entry]));
  const endedRuns = new Set<string>(
    projection.runs
      .filter((run) =>
        ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status),
      )
      .map((run) => run.id),
  );
  const endedTurns = new Set<string>(
    projection.providerTurns
      .filter((turn) => turn.status !== "running" && turn.status !== "pending")
      .map((turn) => turn.id),
  );
  const endedSessions = new Set<string>(
    projection.providerSessions
      .filter((session) => session.status === "stopped" || session.status === "error")
      .map((session) => session.id),
  );
  const last = events.at(-1);
  if (last === undefined) return events;
  for (const event of events) {
    if (event.type === "runtime-request.updated") requests.set(event.payload.id, event.payload);
    if (event.type === "node.updated") nodes.set(event.payload.id, event.payload);
    if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
    if (
      event.type === "run.updated" &&
      ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
        event.payload.status,
      )
    )
      endedRuns.add(event.payload.id);
    if (
      event.type === "provider-turn.updated" &&
      event.payload.status !== "running" &&
      event.payload.status !== "pending"
    )
      endedTurns.add(event.payload.id);
    if (
      event.type === "provider-session.updated" &&
      (event.payload.status === "stopped" || event.payload.status === "error")
    )
      endedSessions.add(event.payload.id);
  }
  const expired: OrchestrationV2DomainEvent[] = [];
  for (const request of requests.values()) {
    if (request.status !== "pending" || request.responseCapability.type !== "live") continue;
    // A callback and its owning node/item can first arrive in the batch that ends the run.
    const node = nodes.get(request.nodeId);
    const item = [...items.values()].find(
      (entry) => "requestId" in entry && entry.requestId === request.id,
    );
    const runId = item?.runId ?? node?.runId;
    if (
      !endedSessions.has(request.responseCapability.providerSessionId) &&
      (request.providerTurnId === null || !endedTurns.has(request.providerTurnId)) &&
      (runId == null || !endedRuns.has(runId))
    )
      continue;
    expired.push({
      id: last.id,
      threadId: projection.thread.id,
      nodeId: request.nodeId,
      occurredAt: last.occurredAt,
      ...(runId == null ? {} : { runId }),
      type: "runtime-request.updated",
      payload: { ...request, status: "expired", resolvedAt: last.occurredAt },
    });
  }
  return expired.length ? [...events, ...expired] : events;
}

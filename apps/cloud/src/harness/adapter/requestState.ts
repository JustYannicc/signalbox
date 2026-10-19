import { OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";

import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { ActiveTurn } from "./state.ts";
import type { HarnessOpenInput } from "../Harness.ts";

export const requestBelongsToSession = (
  request: OrchestrationV2RuntimeRequest,
  input: HarnessOpenInput,
  driver: string,
) =>
  (request.nativeRequestRef === null || request.nativeRequestRef.driver === driver) &&
  (request.responseCapability.type !== "live" ||
    request.responseCapability.providerSessionId === input.session.providerSessionId);

export const sameRequestIdentity = (
  left: OrchestrationV2RuntimeRequest,
  right: OrchestrationV2RuntimeRequest,
) =>
  left.id === right.id &&
  left.nodeId === right.nodeId &&
  left.providerTurnId === right.providerTurnId &&
  left.kind === right.kind &&
  left.nativeRequestRef?.driver === right.nativeRequestRef?.driver &&
  left.nativeRequestRef?.nativeId === right.nativeRequestRef?.nativeId &&
  left.nativeRequestRef?.strength === right.nativeRequestRef?.strength;

const sameRequest = Schema.toEquivalence(OrchestrationV2RuntimeRequest);

export const retainRequest = (
  requests: Map<string, OrchestrationV2RuntimeRequest>,
  request: OrchestrationV2RuntimeRequest,
) => {
  const prior = requests.get(request.id);
  // Provider callbacks may finish after control delivery or repeat a pending row.
  if (
    prior !== undefined &&
    (prior.status !== "pending" ||
      !sameRequestIdentity(prior, request) ||
      sameRequest(prior, request))
  )
    return false;
  requests.set(request.id, request);
  return true;
};

export const mergeRequests = (
  snapshot: ProviderAdapterV2ThreadSnapshot,
  retained: ReadonlyMap<string, OrchestrationV2RuntimeRequest>,
) => {
  const requests = new Map(snapshot.runtimeRequests.map((request) => [request.id, request]));
  for (const request of retained.values()) requests.set(request.id, request);
  return { ...snapshot, runtimeRequests: [...requests.values()] };
};

export const requestEvent = (runtimeRequest: OrchestrationV2RuntimeRequest, active: ActiveTurn) =>
  ({
    type: "runtime_request.updated",
    driver: active.providerThread.driver,
    threadId: active.input.threadId,
    runtimeRequest,
  }) satisfies ProviderAdapterV2Event;

export const cancelRequests = (
  active: ActiveTurn,
  retained: Map<string, OrchestrationV2RuntimeRequest>,
  resolvedAt: DateTime.Utc,
) => {
  const cancelled: OrchestrationV2RuntimeRequest[] = [];
  for (const request of active.requests.values()) {
    if (request.status !== "pending" || request.responseCapability.type !== "live") continue;
    const resolved = { ...request, status: "cancelled" as const, resolvedAt };
    retained.set(request.id, resolved);
    cancelled.push(resolved);
  }
  active.requests.clear();
  return cancelled;
};

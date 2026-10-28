import type { HarnessProcessResumeOperationInput } from "../processResume/contracts.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { readProcessBoundary } from "./boundary.ts";
import { activeKey, ownedRequestKey, readOwned } from "./ownedRequest.ts";

/** Public operation IDs survive an automatic restore; private publisher capabilities do not. */
export async function normalizeBoundaryResume(
  storage: DurableObjectStorage,
  operation: HarnessProcessResumeOperationInput,
) {
  const boundary = await readProcessBoundary(storage, operation.runId);
  if (
    boundary === undefined ||
    operation.previousOperationId !== boundary.callerOperationId ||
    boundary.callerOperationId === boundary.process.operationId
  )
    return operation;
  if (boundary.phase === "retained" || boundary.phase === "restoring")
    throw new Error("The restored process needs explicit repair before resuming.");
  const key = ownedRequestKey(
    operation.runId,
    boundary.process.operationId,
    operation.previousStepId,
  );
  const owned = readOwned(await storage.get(key));
  if (
    (await storage.get(activeKey(operation.runId))) !== key ||
    operation.previousProcessId !== boundary.process.processId ||
    operation.runStore.processOperationId !== boundary.callerOperationId ||
    operation.runStore.controlKey !== boundary.runStore.controlKey ||
    !sameData(operation.runStore.supervisor, boundary.runStore.supervisor) ||
    (!sameData(operation.runStore.currentPublisher, boundary.callerPublisher) &&
      !sameData(operation.runStore.currentPublisher, boundary.requestPublisher)) ||
    !sameData(operation.transition.control, boundary.control) ||
    !sameData(operation.transition.publisher, boundary.prepared.preparedPublisher) ||
    operation.transition.expectedFacetGeneration !== boundary.requestPublisher.generation ||
    !sameData(owned.identity, boundary.prepared.identity) ||
    !sameData(owned.placement, boundary.placement) ||
    !sameData(owned.fence, boundary.fence) ||
    !sameData(owned.control, boundary.control) ||
    !sameData(owned.runStorePublisher, boundary.requestPublisher) ||
    owned.process.nativeSessionId !== boundary.nativeSessionId ||
    !sameData(owned.request, operation.runStore.request) ||
    !sameData(owned.parentCheckpoint, operation.runStore.checkpoint)
  )
    throw new Error("Resume does not identify the caller's exact restored process.");
  return {
    ...operation,
    previousOperationId: boundary.process.operationId,
    runStore: {
      ...operation.runStore,
      processOperationId: boundary.process.operationId,
      currentPublisher: boundary.requestPublisher,
    },
  };
}

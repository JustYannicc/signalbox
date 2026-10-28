import type { HarnessDurableState, HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { HarnessProcessResumeOperationInput } from "../processResume/contracts.ts";
import { sameControl, samePublisher } from "../processResume/authority.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import {
  validateHarnessProcessResumeRunStoreDrain,
  validateHarnessProcessResumeRunStoreStart,
} from "../processResume/runStore.ts";
import {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  sameEvictedRecoveryReceipt,
  sameEvictedRecoverySource,
  sameProcessPlacementIdentity,
  sameWriter,
} from "../processPlacement/storeSchema.ts";
import type { HarnessProcessPlacementStoreClient } from "../processPlacement/durableStore.ts";
import { fenceHistoryKey, readProcessFence, sameProcessFence, type ProcessFence } from "./fence.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import {
  activeKey,
  ownedRequestKey,
  readOwned,
  reserveOwnedResume,
  type DurableOwnedRequest,
} from "./ownedRequest.ts";
import { readProcessBoundary } from "./boundary.ts";
import {
  assertEvictedStopBoundary,
  evictedStopKey,
  readEvictedStopReceipt,
  type EvictedStopReceipt,
} from "./stopEvicted.ts";

export interface EvictedStopResumeProof {
  readonly kind: "parent-destroyed";
  readonly key: string;
  readonly receipt: EvictedStopReceipt;
  readonly boundary: import("./boundary.ts").ProcessBoundary;
  readonly sourceParentCheckpoint: DurableOwnedRequest["parentCheckpoint"];
  readonly reservationFence: ProcessFence;
}

export interface ReservedEvictedStopResume {
  readonly source: DurableOwnedRequest;
  readonly destruction: EvictedStopResumeProof;
}

export async function reserveEvictedStopResume(input: {
  readonly storage: DurableObjectStorage;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly durable: HarnessDurableState;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly incarnation: ProcessIncarnation;
}): Promise<ReservedEvictedStopResume | undefined> {
  const { operation, storage } = input;
  const key = evictedStopKey(operation.runId, operation.previousStepId);
  const stored = await storage.get<unknown>(key);
  if (stored === undefined) return undefined;

  const receipt = readEvictedStopReceipt(stored);
  const boundary = await readProcessBoundary(storage, operation.runId);
  if (boundary === undefined) throw new Error("The stopped evicted process boundary is missing.");
  assertEvictedStopBoundary(receipt, boundary);
  const reservationFence = await input.incarnation.assertCurrent();
  const sourceKey = ownedRequestKey(
    operation.runId,
    operation.previousOperationId,
    operation.previousStepId,
  );
  if ((await storage.get(activeKey(operation.runId))) !== sourceKey)
    throw new Error("The evicted-stop receipt does not identify the active owned request.");
  const source = readOwned(await storage.get(sourceKey));
  const proof: EvictedStopResumeProof = {
    kind: "parent-destroyed",
    key,
    receipt,
    boundary,
    sourceParentCheckpoint: source.parentCheckpoint,
    reservationFence,
  };
  await assertEvictedStopResumeProof({
    storage,
    environment: input.environment,
    durable: input.durable,
    operation,
    source,
    proof,
    currentFence: reservationFence,
  });
  const currentFence = await input.incarnation.assertCurrent();
  if (!sameProcessFence(currentFence, reservationFence))
    throw new Error("The process shard changed while reserving the evicted source.");

  const reserved = await reserveOwnedResume(storage, operation, input.incarnation, {
    receiptKey: key,
    receipt,
    boundaryKey: `harness-process-boundary/v1/${encodeURIComponent(operation.runId)}`,
    boundary,
    expectedRecord: source,
    sourceFence: receipt.sourceFence,
    observedBy: receipt.observedBy,
    reservationFence,
  });
  return { source: reserved, destruction: proof };
}

export async function assertEvictedStopResumeProof(input: {
  readonly storage: DurableObjectStorage;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly durable: HarnessDurableState;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly source: DurableOwnedRequest;
  readonly proof: EvictedStopResumeProof;
  readonly currentFence: ProcessFence;
  readonly requireReservation?: boolean;
}): Promise<HarnessRequestCheckpoint> {
  const { currentFence, durable, operation, proof, source, storage } = input;
  const sourceKey = ownedRequestKey(
    source.runId,
    source.process.operationId,
    source.request.requestId,
  );
  const persisted = readOwned(await storage.get(sourceKey));
  const { resumeClaim, ...persistedSource } = persisted;
  const { resumeClaim: _sourceClaim, ...originalSource } = source;
  if (
    (await storage.get(activeKey(operation.runId))) !== sourceKey ||
    !sameData(persistedSource, originalSource) ||
    (input.requireReservation === true && resumeClaim === undefined) ||
    (resumeClaim !== undefined &&
      (resumeClaim.operationId !== operation.transition.operationId ||
        !sameProcessFence(resumeClaim.fence, proof.reservationFence) ||
        !sameData(resumeClaim.nextControl, operation.transition.nextControl)))
  )
    throw new Error("The destruction source no longer belongs to this resume reservation.");
  const key = evictedStopKey(operation.runId, operation.previousStepId);
  const receipt = readEvictedStopReceipt(await storage.get<unknown>(key));
  const boundary = await readProcessBoundary(storage, operation.runId);
  if (boundary === undefined) throw new Error("The stopped evicted process boundary is missing.");
  assertEvictedStopBoundary(receipt, boundary);
  if (
    proof.kind !== "parent-destroyed" ||
    proof.key !== key ||
    !sameData(proof.receipt, receipt) ||
    !sameData(proof.boundary, boundary) ||
    !sameData(proof.sourceParentCheckpoint, source.parentCheckpoint) ||
    !sameProcessFence(proof.reservationFence, currentFence) ||
    !sameProcessFence(receipt.sourceFence, source.fence) ||
    !sameProcessFence(receipt.source.fence, source.fence) ||
    receipt.observedBy.owner !== proof.reservationFence.owner ||
    receipt.observedBy.incarnation > proof.reservationFence.incarnation ||
    source.runId !== operation.runId ||
    source.process.processId !== operation.previousProcessId ||
    source.process.operationId !== operation.previousOperationId ||
    source.request.requestId !== operation.previousStepId ||
    source.retained ||
    source.terminalKey !== undefined ||
    source.legacySource !== undefined ||
    !sameData(source.request, operation.runStore.request) ||
    !sameData(source.parentCheckpoint, operation.runStore.checkpoint) ||
    !sameData(source.runStorePublisher, operation.runStore.currentPublisher) ||
    !sameData(source.control, operation.transition.control) ||
    !samePublisher(source.publisher, operation.transition.publisher) ||
    !sameData(source.placement, boundary.placement) ||
    !sameData(source.identity, boundary.prepared.identity) ||
    !samePublisher(boundary.prepared.preparedPublisher, source.publisher) ||
    !sameData(boundary.lastRequest?.request, source.request) ||
    boundary.lastRequest?.ownedKey !==
      ownedRequestKey(source.runId, source.process.operationId, source.request.requestId) ||
    operation.runStore.processOperationId !== source.process.operationId ||
    operation.runStore.transitionOperationId !== operation.transition.operationId ||
    operation.transition.expectedFacetGeneration !== operation.transition.publisher.generation ||
    operation.transition.expectedFacetGeneration !== source.runStorePublisher.generation ||
    !sameControl(operation.transition.control, boundary.control) ||
    !samePublisher(operation.transition.publisher, boundary.prepared.preparedPublisher) ||
    operation.previousProcessId !== boundary.process.processId ||
    operation.runStore.processId !== boundary.process.processId ||
    operation.runStore.runId !== boundary.runId ||
    operation.runStore.request.requestId !== boundary.lastRequest?.request.requestId ||
    !sameData(operation.runStore.supervisor, boundary.runStore.supervisor) ||
    !sameData(operation.runStore.checkpoint, source.parentCheckpoint)
  )
    throw new Error("The explicit resume does not identify the exact evicted-stop source.");
  if (
    source.resumeClaim !== undefined &&
    (source.resumeClaim.operationId !== operation.transition.operationId ||
      !sameProcessFence(source.resumeClaim.fence, proof.reservationFence) ||
      !sameData(source.resumeClaim.nextControl, operation.transition.nextControl))
  )
    throw new Error("The destruction receipt is not attached to this resume reservation.");

  await assertFenceHistory(storage, receipt.sourceFence, receipt.observedBy, currentFence);
  await assertPlacementRetirement(input.environment, storage, receipt);

  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: operation.runId,
    control: operation.transition.control,
  });
  if (
    current.snapshot.lifecycle !== "recoverable" ||
    current.snapshot.admittedStepId !== null ||
    current.snapshot.pendingControlSync !== null ||
    current.snapshot.preparedFacet !== null ||
    current.snapshot.nativeSessionId !== source.process.nativeSessionId ||
    !samePublisher(current.currentPublisher, source.publisher) ||
    !sameData(current.snapshot.checkpoint, {
      checkpointId: boundary.checkpoint.native.id,
      manifestSha256: boundary.checkpoint.filesystem.sha256,
    }) ||
    (boundary.publication !== undefined &&
      current.snapshot.lastPublicationOperationId !== source.process.operationId)
  )
    throw new Error("A no longer matches the exact parent-destruction source authority.");

  await validateHarnessProcessResumeRunStoreStart({
    store: durable.runStore,
    operation,
    activeCheckpoint: {
      checkpointId: source.parentCheckpoint.native.id,
      manifestSha256: source.parentCheckpoint.filesystem.sha256,
    },
  });
  await validateHarnessProcessResumeRunStoreDrain({
    store: durable.runStore,
    operation,
    checkpoint: {
      checkpointId: boundary.checkpoint.native.id,
      manifestSha256: boundary.checkpoint.filesystem.sha256,
      nativeSessionId: boundary.nativeSessionId,
    },
  });
  const files = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId: operation.runId,
    publisher: boundary.prepared.preparedPublisher,
    checkpointId: boundary.checkpoint.native.id,
  });
  if (
    files.checkpoint.checkpointId !== boundary.checkpoint.native.id ||
    files.checkpoint.manifestSha256 !== boundary.checkpoint.filesystem.sha256
  )
    throw new Error("The evicted source checkpoint bytes no longer match its durable receipt.");

  const confirmed = await durable.threadSupervisor.execute({
    type: "read",
    runId: operation.runId,
    control: operation.transition.control,
  });
  if (
    !sameData(confirmed.snapshot, current.snapshot) ||
    !samePublisher(confirmed.currentPublisher, current.currentPublisher)
  )
    throw new Error("A changed while the eviction source was being authenticated.");
  return boundary.checkpoint;
}

async function assertFenceHistory(
  storage: DurableObjectStorage,
  sourceFence: ProcessFence,
  observedBy: ProcessFence,
  reservationFence: ProcessFence,
) {
  const sourceHistory = await storage.get<unknown>(fenceHistoryKey(sourceFence.incarnation));
  const observedHistory = await storage.get<unknown>(fenceHistoryKey(observedBy.incarnation));
  if (
    sourceHistory === undefined ||
    observedHistory === undefined ||
    !sameProcessFence(readProcessFence(sourceHistory), sourceFence) ||
    !sameProcessFence(readProcessFence(observedHistory), observedBy) ||
    sourceFence.owner !== observedBy.owner ||
    observedBy.owner !== reservationFence.owner ||
    sourceFence.incarnation >= observedBy.incarnation ||
    observedBy.incarnation > reservationFence.incarnation ||
    sourceFence.nonce === observedBy.nonce
  )
    throw new Error(
      "The evicted-stop source and observation fences are not in this shard history.",
    );
}

async function assertPlacementRetirement(
  environment: HarnessProcessExecutionEnvironment,
  storage: DurableObjectStorage,
  receipt: EvictedStopReceipt,
) {
  const source = receipt.source;
  const owner = source.placement.owner;
  if (source.publication === undefined)
    throw new Error("An explicit resume requires an evicted published process placement.");
  const localValue = await storage.get<unknown>(
    evictedRecoveryKey(owner, receipt.sourceFence, source.prepared.identity),
  );
  if (localValue === undefined)
    throw new Error("The parent destruction has no local placement retirement receipt.");
  const local = parseEvictedRecoveryReceipt(localValue);
  const store = environment.PLACEMENT_STORES.getByName(
    owner,
  ) as unknown as HarnessProcessPlacementStoreClient;
  const remoteValue = await store.readEvictedRecovery(
    owner,
    receipt.sourceFence,
    source.prepared.identity,
  );
  if (remoteValue === undefined) throw new Error("The placement retirement receipt is missing.");
  const remote = parseEvictedRecoveryReceipt(remoteValue);
  const sourceWriter = {
    executionOperationId: source.placement.executionOperationId,
    shardIndex: source.placement.shardIndex,
    shardIncarnationNonce: receipt.sourceFence.nonce,
    controllerClaim: source.control,
  };
  const currentWriter = {
    ...sourceWriter,
    shardIncarnationNonce: receipt.observedBy.nonce,
  };
  const retirementSource = {
    owner,
    sourceFence: receipt.sourceFence,
    sourceWriter,
    processId: source.process.processId,
    identity: source.prepared.identity,
  };
  if (
    local.state !== "completed" ||
    remote.state !== "completed" ||
    !sameEvictedRecoveryReceipt(local, remote) ||
    !sameProcessFence(remote.currentFence, receipt.observedBy) ||
    !sameEvictedRecoverySource(remote, retirementSource) ||
    !sameProcessPlacementIdentity(remote.identity, source.prepared.identity) ||
    !sameWriter(remote.currentWriter, currentWriter) ||
    !(await store.writerReleased(owner, remote.currentWriter))
  )
    throw new Error(
      "The parent-destruction receipt does not prove completed placement retirement.",
    );
}

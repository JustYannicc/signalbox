import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "../processPlacement/durableStore.ts";
import { sameControl, samePublisher } from "../processResume/authority.ts";
import { sameWriter } from "../processPlacement/storeSchema.ts";
import { readCreationFacet } from "./placement.ts";
import {
  creationPlacementKey,
  readyCreation,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationPlacement,
} from "./contracts.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";

export interface HarnessProcessCreationRecoveryInput {
  readonly runId: string;
  readonly operationId: string;
  readonly drainOperationId: string;
  readonly control: HarnessProcessCreationPlacement["input"]["controllerClaim"];
  readonly nextControl: HarnessProcessCreationPlacement["input"]["controllerClaim"];
}

/** Before the first request, retire the observed initial process so ordinary strict restore can run. */
export async function recoverBoundCreation(
  context: DurableObjectState,
  environment: HarnessProcessCreationEnvironment,
  incarnationNonce: string,
  supplied: HarnessProcessCreationRecoveryInput,
  binding: HarnessProcessCreationBinding,
) {
  const input = structuredClone(supplied);
  const key = creationPlacementKey(input.runId);
  let placement = await context.storage.get<HarnessProcessCreationPlacement>(key);
  if (
    !placement?.identity ||
    placement.operationId !== input.operationId ||
    placement.owner !== context.id.name ||
    !sameControl(placement.input.controllerClaim, input.control) ||
    placement.identity.incarnationNonce !== binding.identity.incarnationNonce
  )
    throw new Error("Recovery does not identify the exact bound initial placement.");
  const durable = createHarnessDurableState(environment, input.runId);
  const journal = await durable.runStore.execute({ type: "read", runId: input.runId });
  if (
    !journal.snapshot.requests ||
    journal.snapshot.requests.entries.length !== 0 ||
    (await context.storage.get(
      `harness-process-creation-invocation/v1/${encodeURIComponent(input.runId)}`,
    )) !== undefined
  )
    throw new Error("A dispatched initial request requires normal request reconciliation.");
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: input.runId,
    control: input.control,
  });
  if (
    current.snapshot.nativeSessionId !== binding.nativeSessionId ||
    !samePublisher(current.currentPublisher, binding.initialization.publisher) ||
    current.snapshot.admittedStepId !== null ||
    current.snapshot.checkpoint.checkpointId !== binding.checkpoint.native.id ||
    current.snapshot.checkpoint.manifestSha256 !== binding.checkpoint.filesystem.sha256
  )
    throw new Error("Bound recovery cannot change the native session or initial checkpoint.");
  const drained = await durable.beginDrain({
    control: input.control,
    publisher: binding.initialization.publisher,
    expectedGeneration: 1,
    operationId: input.drainOperationId,
    nextControl: input.nextControl,
  });
  if (drained.status !== "draining")
    throw new Error("Initial recovery control synchronization is incomplete.");
  if (!placement.disposed) {
    const stub = readCreationFacet(context, environment, {
      ...placement,
      identity: placement.identity,
    });
    const actual = await stub.identity();
    if (actual.facetNonce !== placement.identity.incarnationNonce)
      throw new Error("Initial recovery cannot prove the retained native incarnation stopped.");
    await stub.dispose(actual.facetNonce);
    placement = { ...placement, disposed: true };
    await context.storage.put(key, placement);
  }
  if (!placement.released) {
    const store = environment.PLACEMENT_STORES.getByName(
      placement.owner,
    ) as unknown as HarnessProcessPlacementStoreClient;
    const writer = { ...placement.writer, shardIncarnationNonce: incarnationNonce };
    const currentWriter = await store.readWriter(placement.owner);
    if (!currentWriter) throw new Error("Initial lease release has no known writer disposition.");
    if (!sameWriter(currentWriter, writer)) await store.claimWriter(placement.owner, writer);
    const stores = createHarnessProcessPlacementStoreClient(store, placement.owner, writer);
    const expectedLease = placement.lease;
    await createProcessSlots({
      owner: placement.owner,
      inFlightLimit: 1,
      residentByteLimit: Number(environment.RESIDENT_BYTE_LIMIT),
      store: stores.processSlots,
      scheduleQuantum: (callback) => {
        queueMicrotask(callback);
        return () => {};
      },
      invalidate: (loaderId) => {
        context.facets.abort(loaderId, "Bound initial process stopped.");
        context.facets.delete(loaderId);
      },
      reconcile: async (lease) => {
        if (
          lease.token !== expectedLease.token ||
          lease.loaderId !== expectedLease.loaderId ||
          lease.codeId !== expectedLease.codeId
        )
          throw new Error("Initial recovery encountered another process lease.");
        return { acknowledged: true };
      },
    });
    await store.releaseWriter(placement.owner, writer);
    placement = { ...placement, released: true };
    await context.storage.put(key, placement);
  }
  await durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId: input.runId,
    control: input.nextControl,
    publisher: binding.initialization.publisher,
    expectedGeneration: 1,
    requestId: input.operationId,
    acknowledgementId: `${input.drainOperationId}/initial-disposed`,
  });
  const stopped = await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: input.runId,
    control: input.nextControl,
    publisher: binding.initialization.publisher,
    expectedGeneration: 1,
    outcome: "stopped",
    invocationRpcJoined: true,
    fetchJoined: true,
    callbackPortsJoined: true,
  });
  if (
    stopped.snapshot.lifecycle !== "stopped" ||
    stopped.snapshot.nativeSessionId !== binding.nativeSessionId
  )
    throw new Error("Initial recovery did not confirm the strict resume boundary.");
  return {
    ...readyCreation(input.operationId, binding, "bound"),
    control: input.nextControl,
    lifecycle: "stopped" as const,
  };
}

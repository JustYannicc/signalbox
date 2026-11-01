import { readRpcData, rpcStubOwner } from "../../rpc/Resources.ts";
import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "../processPlacement/durableStore.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessEvictedRecoveryReceipt,
  HarnessProcessPlacementIdentity,
  HarnessProcessPlacementRecoveryRecord,
} from "../processPlacement/contracts.ts";
import type { HarnessProcessResumePlacementPin } from "../processResume/durableState.ts";
import { fenceHistoryKey, readProcessFence, sameProcessFence } from "./fence.ts";
import type { ProcessFence } from "./fence.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  sameEvictedRecoveryReceipt,
  sameEvictedRecoverySource,
  sameProcessSlotLease,
  sameWriter,
  type HarnessProcessPlacementWriter,
} from "../processPlacement/storeSchema.ts";

export interface RetireEvictedPlacementSource {
  readonly fence: ProcessFence;
  readonly placement: HarnessProcessResumePlacementPin;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly processId: string;
  readonly control: HarnessProcessControllerClaim;
}

/** Retires one published facet whose owning C incarnation was fenced out and destroyed. */
export async function retireEvictedPlacement(input: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment;
  readonly incarnation: ProcessIncarnation;
  readonly source: RetireEvictedPlacementSource;
}): Promise<void> {
  const { context, environment, incarnation, source } = input;
  const currentFence = await incarnation.assertCurrent();
  validateSource(source, currentFence);
  const residentByteLimit = Number(environment.RESIDENT_BYTE_LIMIT);
  if (!Number.isSafeInteger(residentByteLimit) || residentByteLimit <= 0)
    throw new RangeError("Process execution shard resident-byte limit is invalid.");
  const history = await context.storage.get<unknown>(fenceHistoryKey(source.fence.incarnation));
  if (history === undefined || !sameProcessFence(readProcessFence(history), source.fence))
    throw new Error("Evicted placement source is absent from this shard's fence history.");

  const expectedSourceWriter = sourceWriter(source);
  const currentWriter = writerFor(source, currentFence);
  const store = environment.PLACEMENT_STORES.getByName(
    source.placement.owner,
  ) as unknown as HarnessProcessPlacementStoreClient;
  using _storeOwner = rpcStubOwner(store);
  const storedReceipt = await readRpcData(
    store.readEvictedRecovery(source.placement.owner, source.fence, source.identity),
  );
  const localReceipt = await context.storage.get<HarnessProcessEvictedRecoveryReceipt>(
    evictedRecoveryKey(source.placement.owner, source.fence, source.identity),
  );
  if (localReceipt !== undefined) {
    assertReceiptMatchesSource(parseEvictedRecoveryReceipt(localReceipt), source);
    if (
      storedReceipt?.state !== "completed" ||
      !sameEvictedRecoveryReceipt(localReceipt, storedReceipt)
    )
      throw new Error("The local eviction receipt lacks matching durable placement completion.");
    return;
  }

  const writer = await readRpcData(store.readWriter(source.placement.owner));
  if (storedReceipt?.state === "completed") {
    assertReceiptMatchesSource(storedReceipt, source);
    await releaseCompletedWriter(
      store,
      source,
      currentFence,
      currentWriter,
      expectedSourceWriter,
      writer,
    );
    await saveLocalReceipt(incarnation, source, storedReceipt);
    return;
  }
  if (
    writer === undefined ||
    (!sameWriter(writer, expectedSourceWriter) &&
      (storedReceipt === undefined || !sameWriter(writer, storedReceipt.currentWriter)) &&
      !sameWriter(writer, currentWriter))
  )
    throw new Error("Evicted placement has no exact source or authorized recovery writer.");

  const receipt = await readRpcData(
    store.authorizeEvictedRecovery(source.placement.owner, {
      sourceFence: source.fence,
      currentFence,
      sourceWriter: expectedSourceWriter,
      currentWriter,
      processId: source.processId,
      identity: source.identity,
    }),
  );
  assertReceiptMatchesSource(receipt, source);
  if (receipt.state === "completed") {
    await releaseCompletedWriter(
      store,
      source,
      currentFence,
      currentWriter,
      expectedSourceWriter,
      writer,
    );
    await saveLocalReceipt(incarnation, source, receipt);
    return;
  }

  if (!sameWriter(writer, currentWriter))
    await readRpcData(store.claimWriter(source.placement.owner, currentWriter));
  const activeWriter = await readRpcData(store.readWriter(source.placement.owner));
  if (activeWriter === undefined || !sameWriter(activeWriter, currentWriter))
    throw new Error("Evicted placement could not claim the current shard writer.");

  const stores = createHarnessProcessPlacementStoreClient(
    store,
    source.placement.owner,
    currentWriter,
  );
  const state = await stores.processSlots.load();
  const records = await stores.recovery.list();
  if (state === undefined || records.length !== 1)
    throw new Error("Evicted placement has missing or additional durable slot state.");
  const recovery = records[0]!;
  assertRecoveryMatchesSource(recovery, source);
  if (!sameProcessSlotLease(recovery.lease, receipt.lease))
    throw new Error("Evicted placement lease differs from its durable retirement receipt.");
  const holders = state.slots.filter((slot) => slot.holder !== undefined);
  if (holders.length > 1 || (holders.length === 1 && !slotHoldsLease(holders[0]!, receipt.lease)))
    throw new Error("Evicted placement has additional held ProcessSlots state.");

  await createProcessSlots({
    owner: source.placement.owner,
    inFlightLimit: 1,
    residentByteLimit,
    store: stores.processSlots,
    scheduleQuantum(callback) {
      queueMicrotask(callback);
      return () => {};
    },
    invalidate: (loaderId) => {
      if (loaderId !== source.identity.loaderId)
        throw new Error("Evicted placement attempted to invalidate another facet.");
      context.facets.abort(loaderId, "The owning process-shard incarnation was destroyed.");
      context.facets.delete(loaderId);
    },
    reconcile: async (lease) => {
      if (!sameProcessSlotLease(lease, receipt.lease))
        throw new Error("Evicted placement encountered another process lease.");
      // A newer durable-object incarnation proves the old parent isolate was destroyed.
      return { lost: "isolate" as const };
    },
  });

  await readRpcData(store.completeEvictedRecovery(source.placement.owner, receipt));
  await readRpcData(store.releaseWriter(source.placement.owner, currentWriter));
  if (!(await readRpcData(store.writerReleased(source.placement.owner, currentWriter))))
    throw new Error("Evicted placement writer release has no durable receipt.");
  const completed = await readRpcData(
    store.readEvictedRecovery(source.placement.owner, source.fence, source.identity),
  );
  if (completed?.state !== "completed")
    throw new Error("Evicted placement retirement did not persist its exact receipt.");
  await saveLocalReceipt(incarnation, source, completed);
}

function sourceWriter(source: RetireEvictedPlacementSource): HarnessProcessPlacementWriter {
  return {
    executionOperationId: source.placement.executionOperationId,
    shardIndex: source.placement.shardIndex,
    shardIncarnationNonce: source.fence.nonce,
    controllerClaim: source.control,
  };
}

function writerFor(
  source: RetireEvictedPlacementSource,
  fence: ProcessFence,
): HarnessProcessPlacementWriter {
  return { ...sourceWriter(source), shardIncarnationNonce: fence.nonce };
}

function validateSource(source: RetireEvictedPlacementSource, current: ProcessFence): void {
  const sourceFence = readProcessFence(source.fence);
  if (
    sourceFence.owner !== current.owner ||
    source.placement.owner !== current.owner ||
    source.placement.shardIncarnationNonce !== sourceFence.nonce ||
    sourceFence.incarnation >= current.incarnation ||
    sourceFence.nonce === current.nonce ||
    !source.placement.executionOperationId ||
    !source.placement.shardOwner ||
    !Number.isSafeInteger(source.placement.shardIndex) ||
    source.placement.shardIndex < 0 ||
    source.identity.shardOwner !== source.placement.owner ||
    source.identity.loaderId !== source.identity.facetKey ||
    !source.identity.incarnationNonce ||
    !source.processId ||
    !source.control.ownerId ||
    !source.control.incarnationId ||
    !Number.isSafeInteger(source.control.epoch) ||
    source.control.epoch <= 0 ||
    !source.control.controlKey
  )
    throw new Error("Evicted placement source does not identify an older exact process owner.");
}

function assertReceiptMatchesSource(
  receipt: HarnessProcessEvictedRecoveryReceipt,
  source: RetireEvictedPlacementSource,
): void {
  if (
    !sameEvictedRecoverySource(receipt, {
      owner: source.placement.owner,
      sourceFence: source.fence,
      sourceWriter: sourceWriter(source),
      processId: source.processId,
      identity: source.identity,
    }) ||
    receipt.lease.loaderId !== source.identity.loaderId
  )
    throw new Error("Evicted placement receipt belongs to another process incarnation.");
}

function assertRecoveryMatchesSource(
  record: HarnessProcessPlacementRecoveryRecord,
  source: RetireEvictedPlacementSource,
): void {
  if (
    record.processId !== source.processId ||
    record.shardOwner !== source.identity.shardOwner ||
    record.controllerClaim.ownerId !== source.control.ownerId ||
    record.controllerClaim.incarnationId !== source.control.incarnationId ||
    record.controllerClaim.epoch !== source.control.epoch ||
    record.controllerClaim.controlKey !== source.control.controlKey ||
    record.loaderId !== source.identity.loaderId ||
    record.facetKey !== source.identity.facetKey ||
    record.identityState !== "observed" ||
    record.incarnationNonce !== source.identity.incarnationNonce ||
    record.terminalFailure !== undefined ||
    (record.state !== "active" && record.state !== "parked") ||
    record.publicationState !== "confirmed" ||
    record.publicationReceipt?.status !== "confirmed" ||
    record.publicationReceipt.preparedFacetNonce !== source.identity.incarnationNonce ||
    (record.invocationMayHaveStarted !== false &&
      !(record.invocationMayHaveStarted === true && record.invocationReply === "received"))
  )
    throw new Error("Evicted placement has no exact idle published-facet record.");
}

function slotHoldsLease(
  slot: {
    readonly codeId: string;
    readonly invalidating?: number;
    readonly holder?: { readonly token: string; readonly residentBytes: number };
  },
  lease: ProcessSlotLease,
): boolean {
  const holder = slot.holder;
  return (
    slot.invalidating === undefined &&
    holder !== undefined &&
    holder.token === lease.token &&
    holder.residentBytes === lease.residentBytes &&
    slot.codeId === lease.codeId
  );
}

async function releaseCompletedWriter(
  store: HarnessProcessPlacementStoreClient,
  source: RetireEvictedPlacementSource,
  currentFence: ProcessFence,
  currentWriter: HarnessProcessPlacementWriter,
  sourceWriter: HarnessProcessPlacementWriter,
  storedWriter: HarnessProcessPlacementWriter | undefined,
): Promise<void> {
  if (storedWriter === undefined) return;
  const receipt = await readRpcData(
    store.readEvictedRecovery(source.placement.owner, source.fence, source.identity),
  );
  if (receipt?.state !== "completed")
    throw new Error("Evicted placement writer has no completed retirement receipt.");
  if (
    !sameWriter(storedWriter, receipt.currentWriter) &&
    !sameWriter(storedWriter, sourceWriter) &&
    !sameWriter(storedWriter, currentWriter)
  )
    throw new Error("Evicted placement writer changed after retirement.");
  if (!sameWriter(storedWriter, currentWriter))
    await readRpcData(store.claimWriter(source.placement.owner, currentWriter));
  await readRpcData(store.releaseWriter(source.placement.owner, currentWriter));
  if (!(await readRpcData(store.writerReleased(source.placement.owner, currentWriter))))
    throw new Error("Evicted placement writer release has no durable receipt.");
  if (currentFence.owner !== source.placement.owner)
    throw new Error("Evicted placement writer release changed owners.");
}

async function saveLocalReceipt(
  incarnation: ProcessIncarnation,
  source: RetireEvictedPlacementSource,
  receipt: HarnessProcessEvictedRecoveryReceipt,
): Promise<void> {
  await incarnation.transaction(async (transaction) => {
    const key = evictedRecoveryKey(source.placement.owner, source.fence, source.identity);
    const existing = await transaction.get<HarnessProcessEvictedRecoveryReceipt>(key);
    if (existing !== undefined && !sameEvictedRecoveryReceipt(existing, receipt))
      throw new Error("Local evicted-placement receipt conflicts with durable placement state.");
    await transaction.put(key, receipt);
  });
}

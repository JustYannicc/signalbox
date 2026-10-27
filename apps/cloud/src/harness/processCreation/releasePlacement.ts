import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "../processPlacement/durableStore.ts";
import { sameWriter } from "../processPlacement/storeSchema.ts";
import {
  creationPlacementKey,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationPlacement,
} from "./contracts.ts";

export async function releaseCreationPlacement(
  context: DurableObjectState,
  environment: HarnessProcessCreationEnvironment,
  incarnationNonce: string,
  supplied: HarnessProcessCreationPlacement,
): Promise<HarnessProcessCreationPlacement> {
  if (supplied.released) return supplied;
  let placement = supplied;
  const key = creationPlacementKey(placement.input.runId);
  const store = environment.PLACEMENT_STORES.getByName(
    placement.owner,
  ) as unknown as HarnessProcessPlacementStoreClient;
  const currentWriter = await store.readWriter(placement.owner);
  if (currentWriter === undefined) {
    if (
      !placement.releaseWriter ||
      !(await store.writerReleased(placement.owner, placement.releaseWriter))
    )
      throw new Error("Initial lease release has no matching durable writer receipt.");
  } else {
    const writer = { ...placement.writer, shardIncarnationNonce: incarnationNonce };
    if (!sameWriter(currentWriter, writer)) await store.claimWriter(placement.owner, writer);
    placement = { ...placement, releaseWriter: writer };
    await context.storage.put(key, placement);
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
  }
  placement = { ...placement, released: true };
  await context.storage.put(key, placement);
  return placement;
}

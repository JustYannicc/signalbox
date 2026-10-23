import type { ProcessSlotState, ProcessSlotStore } from "../../computer/ProcessSlots.ts";
import type {
  HarnessProcessPlacementRecoveryRecord,
  HarnessProcessPlacementRecoveryStore,
} from "./contracts.ts";
import type { HarnessProcessPlacementWriter } from "./storeSchema.ts";
import { parseRecoveryRecord } from "./storeSchema.ts";

export interface HarnessProcessPlacementStoreClient {
  readWriter(owner: string): Promise<HarnessProcessPlacementWriter | undefined>;
  claimWriter(owner: string, writer: HarnessProcessPlacementWriter): Promise<void>;
  releaseWriter(owner: string, writer: HarnessProcessPlacementWriter): Promise<void>;
  load(owner: string, writer: HarnessProcessPlacementWriter): Promise<ProcessSlotState | undefined>;
  save(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    state: ProcessSlotState,
  ): Promise<void>;
  listRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
  ): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
  saveRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    record: HarnessProcessPlacementRecoveryRecord,
  ): Promise<void>;
  removeRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    loaderId: string,
  ): Promise<void>;
}

export function createHarnessProcessPlacementStoreClient(
  client: HarnessProcessPlacementStoreClient,
  owner: string,
  writer: HarnessProcessPlacementWriter,
): {
  readonly processSlots: ProcessSlotStore;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
} {
  return {
    processSlots: {
      load: async () => {
        const state = await client.load(owner, writer);
        if (state !== undefined && state.owner !== owner)
          throw new Error("Process-slot durable owner does not match this shard.");
        return state;
      },
      save: async (state) => {
        if (state.owner !== owner)
          throw new Error("Process-slot durable owner does not match this shard.");
        await client.save(owner, writer, state);
      },
    },
    recovery: {
      list: async () => {
        const entries = await client.listRecovery(owner, writer);
        return entries.map((entry) => parseRecoveryRecord(entry, owner));
      },
      save: async (record) => {
        if (record.shardOwner !== owner || record.lease.token === undefined)
          throw new Error("Process-placement recovery owner or lease is invalid.");
        await client.saveRecovery(owner, writer, record);
      },
      remove: async (loaderId) => await client.removeRecovery(owner, writer, loaderId),
    },
  };
}

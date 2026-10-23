import type { ProcessSlotState, ProcessSlotStore } from "../../computer/ProcessSlots.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementRecoveryRecord,
  HarnessProcessPlacementRecoveryStore,
} from "./contracts.ts";

export interface HarnessProcessPlacementDurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { readonly prefix: string }): Promise<Map<string, T>>;
}

export interface HarnessProcessPlacementStoreClient {
  claimWriter(
    owner: string,
    writer: {
      readonly executionOperationId: string;
      readonly shardIndex: number;
      readonly shardIncarnationNonce: string;
      readonly controllerClaim: HarnessProcessControllerClaim;
    },
  ): Promise<void>;
  releaseWriter(
    owner: string,
    writer: {
      readonly executionOperationId: string;
      readonly shardIndex: number;
      readonly shardIncarnationNonce: string;
      readonly controllerClaim: HarnessProcessControllerClaim;
    },
  ): Promise<void>;
  load(owner: string): Promise<ProcessSlotState | undefined>;
  save(owner: string, state: ProcessSlotState): Promise<void>;
  listRecovery(owner: string): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
  saveRecovery(owner: string, record: HarnessProcessPlacementRecoveryRecord): Promise<void>;
  removeRecovery(owner: string, loaderId: string): Promise<void>;
}

const PROCESS_SLOT_STATE_KEY = "harness-process-slots-v1";
const RECOVERY_PREFIX = "harness-process-placement-recovery-v1/";

export function createHarnessProcessPlacementStores(
  storage: HarnessProcessPlacementDurableStorage,
  owner: string,
): {
  readonly processSlots: ProcessSlotStore;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
} {
  const processSlots: ProcessSlotStore = {
    async load() {
      const state = await storage.get<ProcessSlotState>(PROCESS_SLOT_STATE_KEY);
      if (state !== undefined && state.owner !== owner)
        throw new Error("Process-slot durable owner does not match this shard.");
      return state;
    },
    async save(state) {
      if (state.owner !== owner)
        throw new Error("Process-slot durable owner does not match this shard.");
      await storage.put(PROCESS_SLOT_STATE_KEY, state);
    },
  };

  const recovery: HarnessProcessPlacementRecoveryStore = {
    async list() {
      const entries = await storage.list<unknown>({ prefix: RECOVERY_PREFIX });
      const records = [];
      for (const [key, value] of entries) {
        if (key.startsWith(RECOVERY_PREFIX)) records.push(parseRecoveryRecord(value, owner));
      }
      return records;
    },
    async save(record) {
      if (record.shardOwner !== owner || record.lease.token === undefined)
        throw new Error("Process-placement recovery owner or lease is invalid.");
      await storage.put(recoveryKey(record.loaderId), record);
    },
    async remove(loaderId) {
      await storage.delete(recoveryKey(loaderId));
    },
  };

  return { processSlots, recovery };
}

export function createHarnessProcessPlacementStoreClient(
  client: HarnessProcessPlacementStoreClient,
  owner: string,
): {
  readonly processSlots: ProcessSlotStore;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
} {
  return {
    processSlots: {
      load: () => client.load(owner),
      save: (state) => client.save(owner, state),
    },
    recovery: {
      list: () => client.listRecovery(owner),
      save: (record) => client.saveRecovery(owner, record),
      remove: (loaderId) => client.removeRecovery(owner, loaderId),
    },
  };
}

function recoveryKey(loaderId: string) {
  return `${RECOVERY_PREFIX}${encodeURIComponent(loaderId)}`;
}

function parseRecoveryRecord(value: unknown, owner: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "version") ||
    Reflect.get(value, "version") !== 1 ||
    Reflect.get(value, "shardOwner") !== owner ||
    typeof Reflect.get(value, "loaderId") !== "string" ||
    Reflect.get(value, "facetKey") !== Reflect.get(value, "loaderId") ||
    typeof Reflect.get(value, "incarnationNonce") !== "string"
  )
    throw new Error("Process-placement recovery record is invalid.");
  return value as HarnessProcessPlacementRecoveryRecord;
}

import { DurableObject } from "cloudflare:workers";
import type { ProcessSlotState } from "../../computer/ProcessSlots.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementRecoveryRecord,
} from "./contracts.ts";

const OWNER_KEY = "harness-process-placement-owner-v1";
const STATE_KEY = "harness-process-slots-v1";
const RECOVERY_PREFIX = "harness-process-placement-recovery-v1/";
const WRITER_KEY = "harness-process-placement-writer-v1";

interface WriterRecord {
  readonly executionOperationId: string;
  readonly shardIndex: number;
  readonly shardIncarnationNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
}

export class HarnessProcessPlacementStoreObject extends DurableObject {
  async claimWriter(owner: string, writer: WriterRecord): Promise<void> {
    assertWriter(writer);
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      const existing = await transaction.get<WriterRecord>(WRITER_KEY);
      if (existing !== undefined)
        throw new Error("Another ProcessSlots allocator still owns this durable shard.");
      await transaction.put(WRITER_KEY, writer);
    });
  }

  async releaseWriter(owner: string, writer: WriterRecord): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      const existing = await transaction.get<WriterRecord>(WRITER_KEY);
      if (
        existing === undefined ||
        existing.executionOperationId !== writer.executionOperationId ||
        existing.shardIndex !== writer.shardIndex ||
        existing.shardIncarnationNonce !== writer.shardIncarnationNonce ||
        !sameClaim(existing.controllerClaim, writer.controllerClaim)
      )
        throw new Error("ProcessSlots writer claim changed before release.");
      await transaction.delete(WRITER_KEY);
    });
  }

  async load(owner: string): Promise<ProcessSlotState | undefined> {
    await this.#assertOwner(owner);
    return await this.ctx.storage.get<ProcessSlotState>(STATE_KEY);
  }

  async save(owner: string, state: ProcessSlotState): Promise<void> {
    if (state.owner !== owner)
      throw new Error("Process-slot durable owner does not match this shard.");
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      await transaction.put(STATE_KEY, state);
    });
  }

  async listRecovery(owner: string): Promise<readonly HarnessProcessPlacementRecoveryRecord[]> {
    await this.#assertOwner(owner);
    const entries = await this.ctx.storage.list<HarnessProcessPlacementRecoveryRecord>({
      prefix: RECOVERY_PREFIX,
    });
    const records = [];
    for (const record of entries.values()) {
      if (
        record.shardOwner !== owner ||
        record.version !== 1 ||
        record.facetKey !== record.loaderId
      )
        throw new Error("Process-placement recovery record is invalid.");
      records.push(record);
    }
    return records;
  }

  async saveRecovery(owner: string, record: HarnessProcessPlacementRecoveryRecord): Promise<void> {
    if (record.shardOwner !== owner || record.facetKey !== record.loaderId)
      throw new Error("Process-placement recovery owner or identity is invalid.");
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      await transaction.put(recoveryKey(record.loaderId), record);
    });
  }

  async removeRecovery(owner: string, loaderId: string): Promise<void> {
    await this.#assertOwner(owner);
    await this.ctx.storage.delete(recoveryKey(loaderId));
  }

  async #assertOwner(owner: string): Promise<void> {
    await this.ctx.storage.transaction((transaction) => this.#assertOwnerIn(transaction, owner));
  }

  async #assertOwnerIn(transaction: DurableObjectTransaction, owner: string): Promise<void> {
    const existing = await transaction.get<string>(OWNER_KEY);
    if (existing !== undefined && existing !== owner)
      throw new Error("Process-placement store is already assigned to another shard owner.");
    if (existing === undefined) await transaction.put(OWNER_KEY, owner);
  }
}

function recoveryKey(loaderId: string) {
  return `${RECOVERY_PREFIX}${encodeURIComponent(loaderId)}`;
}

function sameClaim(left: HarnessProcessControllerClaim, right: HarnessProcessControllerClaim) {
  return (
    left.ownerId === right.ownerId &&
    left.incarnationId === right.incarnationId &&
    left.epoch === right.epoch &&
    left.controlKey === right.controlKey
  );
}

function assertWriter(writer: WriterRecord) {
  if (
    !writer.executionOperationId ||
    !Number.isSafeInteger(writer.shardIndex) ||
    writer.shardIndex < 0 ||
    !writer.shardIncarnationNonce
  )
    throw new TypeError("ProcessSlots writer must bind an execution operation and shard index.");
}

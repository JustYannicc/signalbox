import { DurableObject } from "cloudflare:workers";
import type { ProcessSlotState } from "../../computer/ProcessSlots.ts";
import type { HarnessProcessPlacementRecoveryRecord } from "./contracts.ts";
import type { HarnessProcessPlacementStoreClient } from "./durableStore.ts";
import {
  OWNER_KEY,
  RECOVERY_PREFIX,
  STATE_KEY,
  WRITER_KEY,
  assertWriter,
  parseRecoveryRecord,
  recoveryKey,
  sameWriter,
  writerIdentityKey,
  type HarnessProcessPlacementWriter,
} from "./storeSchema.ts";

export class HarnessProcessPlacementStoreObject
  extends DurableObject<HarnessProcessPlacementStoreEnvironment>
  implements HarnessProcessPlacementStoreClient
{
  readonly #activeWriter = new Map<
    string,
    { readonly identity: string; readonly incarnation: string }
  >();

  async readWriter(owner: string): Promise<HarnessProcessPlacementWriter | undefined> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const assigned = await transaction.get<string>(OWNER_KEY);
      if (assigned !== undefined && assigned !== owner)
        throw new Error("Process-placement owner does not match this shard.");
      const current = await transaction.get<unknown>(WRITER_KEY);
      if (current === undefined) return undefined;
      assertWriter(current);
      return current;
    });
  }

  async claimWriter(owner: string, writer: HarnessProcessPlacementWriter): Promise<void> {
    assertWriter(writer);
    const actualIncarnation =
      await this.env.PROCESS_EXECUTION_SHARDS.getByName(owner).executionIncarnationNonce();
    if (!actualIncarnation || actualIncarnation !== writer.shardIncarnationNonce)
      throw new Error("Process-placement writer did not match its live execution incarnation.");
    const active = this.#activeWriter.get(owner);
    if (active?.incarnation === actualIncarnation)
      throw new Error("Another live execution still owns this process-placement shard.");
    if (active !== undefined) this.#activeWriter.delete(owner);
    const identity = writerIdentityKey(writer);
    this.#activeWriter.set(owner, { identity, incarnation: actualIncarnation });
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await this.#assertOwnerIn(transaction, owner, true);
        const current = await transaction.get<unknown>(WRITER_KEY);
        if (current !== undefined) {
          assertWriter(current);
          if (current.shardIncarnationNonce === actualIncarnation)
            throw new Error("The current execution incarnation already owns this durable shard.");
        }
        await transaction.put(WRITER_KEY, writer);
      });
    } catch (error) {
      if (this.#activeWriter.get(owner)?.identity === identity) this.#activeWriter.delete(owner);
      throw error;
    }
  }

  async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter): Promise<void> {
    assertWriter(writer);
    const identity = writerIdentityKey(writer);
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await this.#assertOwnerIn(transaction, owner);
        const current = await transaction.get<unknown>(WRITER_KEY);
        if (current === undefined) throw new Error("Process-placement writer is already released.");
        assertWriter(current);
        if (!sameWriter(current, writer))
          throw new Error("ProcessSlots writer claim changed before release.");
        await transaction.delete(WRITER_KEY);
      });
    } finally {
      if (this.#activeWriter.get(owner)?.identity === identity) this.#activeWriter.delete(owner);
    }
  }

  async load(
    owner: string,
    writer: HarnessProcessPlacementWriter,
  ): Promise<ProcessSlotState | undefined> {
    return await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, writer);
      return await transaction.get<ProcessSlotState>(STATE_KEY);
    });
  }

  async save(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    state: ProcessSlotState,
  ): Promise<void> {
    if (state.owner !== owner)
      throw new Error("Process-slot durable owner does not match this shard.");
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, writer);
      await transaction.put(STATE_KEY, state);
    });
  }

  async listRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
  ): Promise<readonly HarnessProcessPlacementRecoveryRecord[]> {
    return await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, writer);
      const entries = await transaction.list<unknown>({ prefix: RECOVERY_PREFIX });
      return [...entries.values()].map((entry) => parseRecoveryRecord(entry, owner));
    });
  }

  async saveRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    record: HarnessProcessPlacementRecoveryRecord,
  ): Promise<void> {
    const checked = parseRecoveryRecord(record, owner);
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, writer);
      const key = recoveryKey(checked.loaderId);
      const previous = await transaction.get<unknown>(key);
      if (previous !== undefined) {
        const current = parseRecoveryRecord(previous, owner);
        if (
          current.terminalFailure !== undefined &&
          !sameTerminalFailure(current.terminalFailure, checked.terminalFailure)
        )
          throw new Error("A terminal activation failure requires an authorized repair.");
      }
      await transaction.put(key, checked);
    });
  }

  async removeRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    loaderId: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, writer);
      const key = recoveryKey(loaderId);
      const value = await transaction.get<unknown>(key);
      if (value === undefined) return;
      const record = parseRecoveryRecord(value, owner);
      if (record.terminalFailure !== undefined)
        throw new Error("A terminal activation failure requires an authorized repair.");
      await transaction.delete(key);
    });
  }

  async #assertOwnerIn(
    transaction: DurableObjectTransaction,
    owner: string,
    assignIfEmpty = false,
  ): Promise<void> {
    const existing = await transaction.get<string>(OWNER_KEY);
    if (existing !== undefined && existing !== owner)
      throw new Error("Process-placement store is already assigned to another shard.");
    if (existing === undefined) {
      if (!assignIfEmpty) throw new Error("Process-placement shard owner has not been assigned.");
      await transaction.put(OWNER_KEY, owner);
    }
  }

  async #assertCurrentWriterIn(
    transaction: DurableObjectTransaction,
    owner: string,
    writer: HarnessProcessPlacementWriter,
  ): Promise<void> {
    assertWriter(writer);
    await this.#assertOwnerIn(transaction, owner);
    const current = await transaction.get<unknown>(WRITER_KEY);
    if (current === undefined) throw new Error("Process-placement writer is not claimed.");
    assertWriter(current);
    if (!sameWriter(current, writer))
      throw new Error("Process-placement mutation came from a stale writer.");
  }
}

interface HarnessProcessPlacementStoreEnvironment {
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<
    HarnessProcessExecutionIncarnationClient & Rpc.DurableObjectBranded
  >;
}

interface HarnessProcessExecutionIncarnationClient {
  executionIncarnationNonce(): Promise<string>;
}

function sameTerminalFailure(
  left: HarnessProcessPlacementRecoveryRecord["terminalFailure"],
  right: HarnessProcessPlacementRecoveryRecord["terminalFailure"],
): boolean {
  return (
    left?.stage === right?.stage && left?.code === right?.code && left?.message === right?.message
  );
}

import { DurableObject } from "cloudflare:workers";
import {
  assertProcessFenceNonce,
  claimProcessFence,
  readProcessFence,
  receiverFenceKey,
  sameProcessFence,
} from "../processOwnership/fence.ts";
import type { ProcessSlotState } from "../../computer/ProcessSlots.ts";
import type {
  HarnessProcessEvictedRecoveryReceipt,
  HarnessProcessEvictedRecoveryRequest,
  HarnessProcessPlacementRecoveryRecord,
  HarnessProcessPlacementIdentity,
} from "./contracts.ts";
import type { HarnessProcessPlacementStoreClient } from "./durableStore.ts";
import {
  evictedRecoveryKey,
  OWNER_KEY,
  RECOVERY_PREFIX,
  STATE_KEY,
  WRITER_KEY,
  WRITER_RELEASE_KEY,
  assertWriter,
  parseEvictedRecoveryReceipt,
  parseRecoveryRecord,
  recoveryKey,
  sameClaim,
  sameProcessPlacementIdentity as sameEvictedIdentity,
  sameProcessSlotLease as sameLease,
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

  claimProcessFence(fence: unknown) {
    return claimProcessFence(this.ctx.storage, fence);
  }

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
        await assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce);
        const current = await transaction.get<unknown>(WRITER_KEY);
        if (current !== undefined) {
          assertWriter(current);
          if (current.shardIncarnationNonce === actualIncarnation)
            throw new Error("The current execution incarnation already owns this durable shard.");
        }
        await transaction.put(WRITER_KEY, writer);
        await this.writerClaimedIn(transaction, owner, current, writer);
      });
    } catch (error) {
      if (this.#activeWriter.get(owner)?.identity === identity) this.#activeWriter.delete(owner);
      throw error;
    }
  }

  protected async writerClaimedIn(
    _transaction: DurableObjectTransaction,
    _owner: string,
    _previous: HarnessProcessPlacementWriter | undefined,
    _writer: HarnessProcessPlacementWriter,
  ): Promise<void> {}

  async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter): Promise<void> {
    assertWriter(writer);
    const identity = writerIdentityKey(writer);
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await this.#assertOwnerIn(transaction, owner);
        await assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce);
        const current = await transaction.get<unknown>(WRITER_KEY);
        if (current === undefined) {
          const released = await transaction.get<unknown>(WRITER_RELEASE_KEY);
          if (released !== undefined) {
            assertWriter(released);
            if (sameWriter(released, writer)) return;
          }
          throw new Error("Process-placement writer has no matching release receipt.");
        }
        assertWriter(current);
        if (!sameWriter(current, writer))
          throw new Error("ProcessSlots writer claim changed before release.");
        await transaction.put(WRITER_RELEASE_KEY, writer);
        await transaction.delete(WRITER_KEY);
      });
    } finally {
      if (this.#activeWriter.get(owner)?.identity === identity) this.#activeWriter.delete(owner);
    }
  }

  async writerReleased(owner: string, writer: HarnessProcessPlacementWriter): Promise<boolean> {
    assertWriter(writer);
    return this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      const released = await transaction.get<unknown>(WRITER_RELEASE_KEY);
      if (released === undefined) return false;
      assertWriter(released);
      return sameWriter(released, writer);
    });
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
        if (current.identityState === "observed" && checked.identityState !== "observed")
          throw new Error("Observed process identity cannot return to unknown.");
        if (current.invocationMayHaveStarted === true && checked.invocationMayHaveStarted !== true)
          throw new Error("Invocation-start evidence cannot be forgotten.");
        assertInvocationTransition(current, checked);
        if (
          current.publicationState === "confirmed" &&
          (checked.publicationState !== "confirmed" ||
            !samePublicationReceipt(current.publicationReceipt, checked.publicationReceipt))
        )
          throw new Error("Confirmed process publication cannot be replaced or forgotten.");
        if (
          current.publicationState !== undefined &&
          current.publicationState !== "in-progress" &&
          checked.publicationState === "in-progress"
        )
          throw new Error("Process publication reconciliation cannot move backwards.");
        if (
          current.publicationState === "not-published" &&
          checked.publicationState !== "not-published"
        )
          throw new Error("A reconciled non-publication cannot become a publication attempt.");
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
      if (
        record.publicationState !== undefined &&
        (!record.stopAcknowledged ||
          !record.joined.invocationRpc ||
          !record.joined.fetch ||
          !record.joined.ports)
      )
        throw new Error("Published process ownership requires joined stop before record removal.");
      await transaction.delete(key);
    });
  }

  async authorizeEvictedRecovery(
    owner: string,
    request: HarnessProcessEvictedRecoveryRequest,
  ): Promise<HarnessProcessEvictedRecoveryReceipt> {
    return this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      const receiver = await transaction.get<unknown>(receiverFenceKey(owner));
      const currentFence = readProcessFence(receiver);
      assertEvictedRecoveryRequest(owner, request, currentFence);

      const retirementKey = evictedRecoveryKey(owner, request.sourceFence, request.identity);
      const existingValue = await transaction.get<unknown>(retirementKey);
      const existing =
        existingValue === undefined ? undefined : parseEvictedRecoveryReceipt(existingValue);
      if (existing !== undefined) {
        assertSameEvictedRecoverySource(existing, owner, request);
        if (existing.state === "completed") return existing;
      }

      const writerValue = await transaction.get<unknown>(WRITER_KEY);
      if (writerValue === undefined)
        throw new Error("Evicted process recovery has no exact prior writer reservation.");
      assertWriter(writerValue);
      const currentWriter = request.currentWriter;
      if (
        !sameWriter(writerValue, request.sourceWriter) &&
        !sameWriter(writerValue, currentWriter) &&
        (existing === undefined || !sameWriter(writerValue, existing.currentWriter))
      )
        throw new Error("Evicted process recovery writer changed outside its exact owner chain.");

      const recoveryRows = await transaction.list<unknown>({ prefix: RECOVERY_PREFIX });
      if (recoveryRows.size !== 1)
        throw new Error("Evicted process recovery has additional placement records.");
      const recoveryValue = await transaction.get<unknown>(recoveryKey(request.identity.loaderId));
      if (recoveryValue === undefined)
        throw new Error("Evicted process recovery has no exact placement record.");
      const recovery = parseRecoveryRecord(recoveryValue, owner);
      assertEvictedRecoveryRecord(recovery, request);

      const state = await transaction.get<ProcessSlotState>(STATE_KEY);
      if (state === undefined)
        throw new Error("Evicted process recovery has no ProcessSlots state.");
      const leaseHeld = assertExactEvictedLease(state, owner, recovery);
      if (existing === undefined && !leaseHeld)
        throw new Error("Evicted process recovery has no held exact placement lease.");

      const receipt = parseEvictedRecoveryReceipt({
        version: 1,
        owner,
        sourceFence: request.sourceFence,
        currentFence,
        sourceWriter: request.sourceWriter,
        currentWriter,
        processId: request.processId,
        identity: request.identity,
        lease: recovery.lease,
        state: "authorized",
      });
      if (existing !== undefined && !sameLease(existing.lease, receipt.lease))
        throw new Error("Evicted process recovery lease changed after authorization.");
      await transaction.put(retirementKey, receipt);
      return receipt;
    });
  }

  async readEvictedRecovery(
    owner: string,
    sourceFence: HarnessProcessEvictedRecoveryRequest["sourceFence"],
    identity: HarnessProcessPlacementIdentity,
  ): Promise<HarnessProcessEvictedRecoveryReceipt | undefined> {
    return this.ctx.storage.transaction(async (transaction) => {
      await this.#assertOwnerIn(transaction, owner);
      const value = await transaction.get<unknown>(
        evictedRecoveryKey(owner, sourceFence, identity),
      );
      if (value === undefined) return undefined;
      const receipt = parseEvictedRecoveryReceipt(value);
      if (
        receipt.owner !== owner ||
        !sameProcessFence(receipt.sourceFence, sourceFence) ||
        !sameEvictedIdentity(receipt.identity, identity)
      )
        throw new Error("Evicted process recovery receipt belongs to another source identity.");
      return receipt;
    });
  }

  async completeEvictedRecovery(
    owner: string,
    supplied: HarnessProcessEvictedRecoveryReceipt,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await this.#assertCurrentWriterIn(transaction, owner, supplied.currentWriter);
      const currentFence = readProcessFence(
        await transaction.get<unknown>(receiverFenceKey(owner)),
      );
      assertEvictedRecoveryRequest(owner, supplied, currentFence);
      const retirementKey = evictedRecoveryKey(owner, supplied.sourceFence, supplied.identity);
      const saved = parseEvictedRecoveryReceipt(await transaction.get<unknown>(retirementKey));
      assertSameEvictedRecoveryReceipt(saved, owner, supplied);
      if (saved.state === "completed") return;

      const recoveryKeyValue = recoveryKey(supplied.identity.loaderId);
      const recoveryValue = await transaction.get<unknown>(recoveryKeyValue);
      if (recoveryValue === undefined)
        throw new Error("Evicted process recovery record disappeared before retirement.");
      const recovery = parseRecoveryRecord(recoveryValue, owner);
      assertEvictedRecoveryRecord(recovery, supplied);
      if (!sameLease(recovery.lease, saved.lease))
        throw new Error("Evicted process recovery lease changed before retirement.");

      const state = await transaction.get<ProcessSlotState>(STATE_KEY);
      if (
        state === undefined ||
        state.owner !== owner ||
        state.slots.some((slot) => slot.holder !== undefined) ||
        state.slots.some((slot) => slot.invalidating !== undefined)
      )
        throw new Error("Evicted process recovery lease has not been retired by ProcessSlots.");
      const recoveryRows = await transaction.list<unknown>({ prefix: RECOVERY_PREFIX });
      if (recoveryRows.size !== 1 || !recoveryRows.has(recoveryKey(supplied.identity.loaderId)))
        throw new Error("Evicted process recovery has additional placement records.");

      await transaction.delete(recoveryKeyValue);
      await transaction.put(retirementKey, { ...saved, state: "completed" });
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
    await assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce);
    const current = await transaction.get<unknown>(WRITER_KEY);
    if (current === undefined) throw new Error("Process-placement writer is not claimed.");
    assertWriter(current);
    if (!sameWriter(current, writer))
      throw new Error("Process-placement mutation came from a stale writer.");
  }
}

function assertEvictedRecoveryRequest(
  owner: string,
  request: HarnessProcessEvictedRecoveryRequest,
  receiver: ReturnType<typeof readProcessFence>,
): void {
  const sourceFence = readProcessFence(request.sourceFence);
  const currentFence = readProcessFence(request.currentFence);
  assertWriter(request.sourceWriter);
  assertWriter(request.currentWriter);
  if (
    owner !== sourceFence.owner ||
    owner !== currentFence.owner ||
    !sameProcessFence(currentFence, receiver) ||
    sourceFence.incarnation >= currentFence.incarnation ||
    sourceFence.nonce === currentFence.nonce ||
    request.sourceWriter.shardIncarnationNonce !== sourceFence.nonce ||
    request.currentWriter.shardIncarnationNonce !== currentFence.nonce ||
    request.sourceWriter.executionOperationId !== request.currentWriter.executionOperationId ||
    request.sourceWriter.shardIndex !== request.currentWriter.shardIndex ||
    !sameClaim(request.sourceWriter.controllerClaim, request.currentWriter.controllerClaim) ||
    request.identity.shardOwner !== owner ||
    !request.processId ||
    !request.identity.loaderId ||
    request.identity.loaderId !== request.identity.facetKey ||
    !request.identity.incarnationNonce
  )
    throw new Error("Evicted process recovery does not match the current parent fence.");
}

function assertSameEvictedRecoverySource(
  saved: HarnessProcessEvictedRecoveryReceipt,
  owner: string,
  request: HarnessProcessEvictedRecoveryRequest,
): void {
  assertEvictedRecoveryRequest(owner, request, request.currentFence);
  if (
    saved.owner !== owner ||
    !sameProcessFence(saved.sourceFence, request.sourceFence) ||
    saved.processId !== request.processId ||
    !sameEvictedIdentity(saved.identity, request.identity) ||
    !sameWriter(saved.sourceWriter, request.sourceWriter) ||
    !sameWriterLineage(saved.currentWriter, request.currentWriter) ||
    request.currentFence.incarnation < saved.currentFence.incarnation ||
    (request.currentFence.incarnation === saved.currentFence.incarnation &&
      !sameProcessFence(saved.currentFence, request.currentFence))
  )
    throw new Error("Evicted process recovery conflicts with its durable retirement receipt.");
}

function assertSameEvictedRecoveryReceipt(
  saved: HarnessProcessEvictedRecoveryReceipt,
  owner: string,
  supplied: HarnessProcessEvictedRecoveryReceipt,
): void {
  assertSameEvictedRecoverySource(saved, owner, supplied);
  if (
    !sameProcessFence(saved.currentFence, supplied.currentFence) ||
    !sameWriter(saved.currentWriter, supplied.currentWriter) ||
    !sameLease(saved.lease, supplied.lease) ||
    saved.state !== supplied.state
  )
    throw new Error("Evicted process recovery receipt changed before completion.");
}

function sameWriterLineage(
  left: HarnessProcessEvictedRecoveryRequest["sourceWriter"],
  right: HarnessProcessEvictedRecoveryRequest["currentWriter"],
): boolean {
  return (
    left.executionOperationId === right.executionOperationId &&
    left.shardIndex === right.shardIndex &&
    sameClaim(left.controllerClaim, right.controllerClaim)
  );
}

function assertEvictedRecoveryRecord(
  record: HarnessProcessPlacementRecoveryRecord,
  request: HarnessProcessEvictedRecoveryRequest,
): void {
  if (
    record.processId !== request.processId ||
    record.shardOwner !== request.identity.shardOwner ||
    record.loaderId !== request.identity.loaderId ||
    record.facetKey !== request.identity.facetKey ||
    record.identityState !== "observed" ||
    record.incarnationNonce !== request.identity.incarnationNonce ||
    !sameClaim(record.controllerClaim, request.sourceWriter.controllerClaim) ||
    record.terminalFailure !== undefined ||
    (record.state !== "active" && record.state !== "parked") ||
    record.publicationState !== "confirmed" ||
    record.publicationReceipt?.status !== "confirmed" ||
    record.publicationReceipt.preparedFacetNonce !== request.identity.incarnationNonce ||
    (record.invocationMayHaveStarted !== false &&
      !(record.invocationMayHaveStarted === true && record.invocationReply === "received"))
  )
    throw new Error("Evicted process recovery does not identify one idle published facet.");
}

function assertExactEvictedLease(
  state: ProcessSlotState,
  owner: string,
  record: HarnessProcessPlacementRecoveryRecord,
): boolean {
  if (state.version !== 1 || state.owner !== owner || !Array.isArray(state.slots))
    throw new Error("Evicted process recovery has malformed ProcessSlots state.");
  const holders = state.slots.filter((slot) => slot.holder !== undefined);
  if (holders.length === 0) return false;
  if (holders.length !== 1) throw new Error("Evicted process recovery has additional held leases.");
  const holder = holders[0]!;
  const leaseHolder = holder.holder;
  if (
    holder.invalidating !== undefined ||
    leaseHolder === undefined ||
    leaseHolder.token !== record.lease.token ||
    holder.codeId !== record.lease.codeId ||
    leaseHolder.residentBytes !== record.lease.residentBytes
  )
    throw new Error("Evicted process recovery lease differs from its ProcessSlots holder.");
  return true;
}

function assertInvocationTransition(
  current: HarnessProcessPlacementRecoveryRecord,
  checked: HarnessProcessPlacementRecoveryRecord,
): void {
  const currentAttempt = invocationAttempt(current);
  const nextAttempt = invocationAttempt(checked);
  const currentReply = invocationReply(current);
  const nextReply = invocationReply(checked);
  if (nextAttempt < currentAttempt || nextAttempt > currentAttempt + 1)
    throw new Error("A process invocation attempt cannot move backwards or skip ahead.");

  if (nextAttempt === currentAttempt) {
    if (
      current.invocationAttempt !== undefined &&
      checked.invocationAttempt !== current.invocationAttempt
    )
      throw new Error("The current process invocation attempt cannot be forgotten.");
    if (currentReply === "received" && nextReply !== "received")
      throw new Error(
        "An observed invocation reply cannot return to unresolved in the same attempt.",
      );
    if (
      currentAttempt === 0 &&
      current.invocationRequestId !== undefined &&
      checked.invocationRequestId !== current.invocationRequestId
    )
      throw new Error("The published request for the first process invocation cannot change.");
    if (currentAttempt > 0 && checked.invocationRequestId !== current.invocationRequestId)
      throw new Error("A process invocation request cannot change within one attempt.");
    return;
  }

  if (currentAttempt === 0) {
    if (
      nextAttempt !== 1 ||
      nextReply !== "unresolved" ||
      checked.invocationRequestId === undefined ||
      (current.invocationRequestId !== undefined &&
        checked.invocationRequestId !== current.invocationRequestId)
    )
      throw new Error("The first process invocation must persist its request as unresolved.");
    return;
  }
  if (
    currentReply !== "received" ||
    nextReply !== "unresolved" ||
    checked.invocationRequestId === undefined ||
    checked.invocationRequestId === current.invocationRequestId
  )
    throw new Error(
      "A new process invocation requires a received prior attempt and a new request.",
    );
}

function invocationAttempt(record: HarnessProcessPlacementRecoveryRecord): number {
  if (record.invocationAttempt !== undefined) return record.invocationAttempt;
  return record.invocationMayHaveStarted === true || record.invocationReply !== undefined ? 1 : 0;
}

function invocationReply(
  record: HarnessProcessPlacementRecoveryRecord,
): "unresolved" | "received" | undefined {
  if (record.invocationReply !== undefined) return record.invocationReply;
  return record.invocationMayHaveStarted === true ? "unresolved" : undefined;
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

function samePublicationReceipt(
  left: HarnessProcessPlacementRecoveryRecord["publicationReceipt"],
  right: HarnessProcessPlacementRecoveryRecord["publicationReceipt"],
): boolean {
  return (
    left?.operationId === right?.operationId &&
    left?.fromGeneration === right?.fromGeneration &&
    left?.toGeneration === right?.toGeneration &&
    left?.priorFacetNonce === right?.priorFacetNonce &&
    left?.preparedFacetNonce === right?.preparedFacetNonce &&
    left?.checkpoint.checkpointId === right?.checkpoint.checkpointId &&
    left?.checkpoint.manifestSha256 === right?.checkpoint.manifestSha256 &&
    left?.status === right?.status
  );
}

import * as Schema from "effect/Schema";
import { CreationClaim, CreationBinding, CreationRecord } from "./schemas.ts";
import { sameControl } from "../processResume/authority.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { NATIVE_SESSION_UUID } from "./identity.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessDurableStateInitializationInput } from "../durableState/types.ts";
import { prepareCheckpoint } from "../durableState/files/content.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementIdentity,
} from "../processPlacement/contracts.ts";

export interface HarnessProcessCreationClaim {
  readonly runId: string;
  readonly operationId: string;
  readonly processId: string;
  readonly ownerId: string;
  readonly ownerIncarnationId: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly descriptorSha256: string;
}

export interface HarnessProcessCreationBinding {
  readonly nativeSessionId: string;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly initialization: HarnessDurableStateInitializationInput;
}

export interface HarnessProcessCreationRecord {
  readonly claim: HarnessProcessCreationClaim;
  readonly phase: "claimed" | "staged" | "bound";
  readonly binding?: HarnessProcessCreationBinding;
}

const STORAGE_KEY_PREFIX = "harness-process-creation-v1/";
interface JournalStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly transaction: DurableObjectStorage["transaction"];
}

const snapshot = <Value>(value: Value): Value => structuredClone(value);

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Harness process creation ${field} is invalid.`);
}

const validateClaim = Schema.decodeUnknownSync(CreationClaim, { onExcessProperty: "error" });
const decodeBinding = Schema.decodeUnknownSync(CreationBinding, { onExcessProperty: "error" });
const decodeRecord = Schema.decodeUnknownSync(CreationRecord, { onExcessProperty: "error" });

function sameClaim(left: HarnessProcessCreationClaim, right: HarnessProcessCreationClaim): boolean {
  return (
    left.runId === right.runId &&
    left.operationId === right.operationId &&
    left.processId === right.processId &&
    left.ownerId === right.ownerId &&
    left.ownerIncarnationId === right.ownerIncarnationId &&
    left.descriptorSha256 === right.descriptorSha256 &&
    sameControl(left.controllerClaim, right.controllerClaim)
  );
}

function readRecord(value: unknown): HarnessProcessCreationRecord {
  try {
    return snapshot(decodeRecord(value));
  } catch (cause) {
    throw new Error("Harness process creation journal record is corrupt.", { cause });
  }
}

function journalKey(runId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(runId)}`;
}

function validateControlBinding(
  claim: HarnessProcessCreationClaim,
  initialization: HarnessDurableStateInitializationInput,
): void {
  if (!sameControl(claim.controllerClaim, initialization.control))
    throw new Error("Harness process creation initialization uses another controller claim.");
}

async function validateBinding(
  claim: HarnessProcessCreationClaim,
  binding: HarnessProcessCreationBinding,
): Promise<void> {
  if (!NATIVE_SESSION_UUID.test(binding.nativeSessionId))
    throw new Error("Harness process creation native session ID is not a UUID.");
  const initialization = binding.initialization;
  if (initialization.nativeSessionId !== binding.nativeSessionId)
    throw new Error("Harness process creation native session ID does not match initialization.");
  if (initialization.run.seed.identity.runId !== claim.runId)
    throw new Error("Harness process creation initialization belongs to another run.");
  validateControlBinding(claim, initialization);
  requireNonEmpty(binding.identity.shardOwner, "shard owner");
  requireNonEmpty(binding.identity.loaderId, "loader ID");
  requireNonEmpty(binding.identity.facetKey, "facet key");
  requireNonEmpty(binding.identity.incarnationNonce, "facet incarnation nonce");
  if (
    initialization.publisher.generation !== 1 ||
    initialization.publisher.facetNonce !== binding.identity.incarnationNonce
  )
    throw new Error(
      "Harness process creation publisher does not match the initial facet identity.",
    );

  const checkpoint = await prepareCheckpoint(initialization.checkpoint);
  if (
    binding.checkpoint.native.id !== checkpoint.checkpointId ||
    !binding.checkpoint.filesystem.id ||
    initialization.checkpoint.parentCheckpointId !== null ||
    binding.identity.shardOwner !== claim.ownerId ||
    binding.identity.loaderId !== binding.identity.facetKey ||
    binding.checkpoint.filesystem.sha256 !== checkpoint.manifestSha256 ||
    binding.checkpoint.filesystem.bytes !== checkpoint.byteCount
  )
    throw new Error("Harness process creation checkpoint references do not match initialization.");
}

/**
 * Keeps one cold creation candidate per run. Existing claims are returned for recovery and never
 * replaced, so a reconstructed owner cannot silently authorize a second native create.
 */
export class HarnessProcessCreationJournal {
  readonly #storage: JournalStorage;

  constructor(storage: JournalStorage) {
    this.#storage = storage;
  }

  async claim(input: HarnessProcessCreationClaim): Promise<{
    readonly status: "claimed" | "existing";
    readonly record: HarnessProcessCreationRecord;
  }> {
    const claim = snapshot(input);
    validateClaim(claim);
    return this.#storage.transaction(async (transaction) => {
      const key = journalKey(claim.runId);
      const existing = await transaction.get<unknown>(key);
      if (existing !== undefined) {
        const record = readRecord(existing);
        if (record.binding !== undefined) await validateBinding(record.claim, record.binding);
        return { status: "existing" as const, record: snapshot(record) };
      }

      const record: HarnessProcessCreationRecord = { phase: "claimed", claim };
      await transaction.put(key, snapshot(record));
      return { status: "claimed" as const, record: snapshot(record) };
    });
  }

  async stage(
    input: HarnessProcessCreationClaim,
    candidate: HarnessProcessCreationBinding,
  ): Promise<HarnessProcessCreationRecord> {
    const claim = snapshot(input);
    const binding = snapshot(decodeBinding(candidate));
    validateClaim(claim);
    await validateBinding(claim, binding);
    return this.#storage.transaction(async (transaction) => {
      const key = journalKey(claim.runId);
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) throw new Error("Harness process creation claim is missing.");
      const record = readRecord(stored);
      if (!sameClaim(record.claim, claim))
        throw new Error("Harness process creation claim does not own this journal record.");
      if (record.phase === "claimed") {
        const staged: HarnessProcessCreationRecord = {
          phase: "staged",
          claim: snapshot(record.claim),
          binding,
        };
        await transaction.put(key, snapshot(staged));
        return snapshot(staged);
      }
      if (record.binding === undefined || !sameData(record.binding, binding))
        throw new Error("Harness process creation binding is immutable once staged.");
      return snapshot(record);
    });
  }

  async bind(input: HarnessProcessCreationClaim): Promise<HarnessProcessCreationRecord> {
    const claim = snapshot(input);
    validateClaim(claim);
    return this.#storage.transaction(async (transaction) => {
      const key = journalKey(claim.runId);
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) throw new Error("Harness process creation claim is missing.");
      const record = readRecord(stored);
      if (!sameClaim(record.claim, claim))
        throw new Error("Harness process creation claim does not own this journal record.");
      if (record.phase === "claimed")
        throw new Error("Harness process creation cannot bind before its candidate is staged.");
      if (record.phase === "bound") return snapshot(record);

      if (record.binding === undefined)
        throw new Error("Harness process creation journal record is corrupt.");
      const bound: HarnessProcessCreationRecord = {
        phase: "bound",
        claim: snapshot(record.claim),
        binding: snapshot(record.binding),
      };
      await transaction.put(key, snapshot(bound));
      return snapshot(bound);
    });
  }

  async read(runId: string): Promise<HarnessProcessCreationRecord | undefined> {
    requireNonEmpty(runId, "run ID");
    const record = await this.#storage.get<unknown>(journalKey(runId));
    if (record === undefined) return undefined;
    const checked = readRecord(record);
    if (checked.binding !== undefined) await validateBinding(checked.claim, checked.binding);
    return snapshot(checked);
  }
}

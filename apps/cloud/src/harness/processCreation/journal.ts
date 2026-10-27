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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

interface JournalStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly transaction: DurableObjectStorage["transaction"];
}

const snapshot = <Value>(value: Value): Value => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Harness process creation ${field} is invalid.`);
}

function validateClaim(claim: HarnessProcessCreationClaim): void {
  requireNonEmpty(claim.runId, "run ID");
  requireNonEmpty(claim.operationId, "operation ID");
  requireNonEmpty(claim.processId, "process ID");
  requireNonEmpty(claim.ownerId, "owner ID");
  requireNonEmpty(claim.ownerIncarnationId, "owner incarnation ID");
  if (!isObject(claim.controllerClaim))
    throw new Error("Harness process creation controller claim is invalid.");
  requireNonEmpty(claim.controllerClaim.ownerId, "controller owner ID");
  requireNonEmpty(claim.controllerClaim.incarnationId, "controller incarnation ID");
  requireNonEmpty(claim.controllerClaim.controlKey, "controller key");
  if (!Number.isSafeInteger(claim.controllerClaim.epoch) || claim.controllerClaim.epoch < 1)
    throw new Error("Harness process creation controller epoch is invalid.");
  if (!SHA256.test(claim.descriptorSha256))
    throw new Error("Harness process creation descriptor hash is invalid.");
}

function sameControllerClaim(
  left: HarnessProcessControllerClaim,
  right: HarnessProcessControllerClaim,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.incarnationId === right.incarnationId &&
    left.epoch === right.epoch &&
    left.controlKey === right.controlKey
  );
}

function sameClaim(left: HarnessProcessCreationClaim, right: HarnessProcessCreationClaim): boolean {
  return (
    left.runId === right.runId &&
    left.operationId === right.operationId &&
    left.processId === right.processId &&
    left.ownerId === right.ownerId &&
    left.ownerIncarnationId === right.ownerIncarnationId &&
    left.descriptorSha256 === right.descriptorSha256 &&
    sameControllerClaim(left.controllerClaim, right.controllerClaim)
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    );
  }
  if (left instanceof ArrayBuffer && right instanceof ArrayBuffer) {
    return sameValue(new Uint8Array(left), new Uint8Array(right));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
  );
}

function readRecord(value: unknown): HarnessProcessCreationRecord {
  if (
    !isObject(value) ||
    (value.phase !== "claimed" && value.phase !== "staged" && value.phase !== "bound")
  )
    throw new Error("Harness process creation journal record is corrupt.");
  const claim = value.claim;
  if (!isObject(claim)) throw new Error("Harness process creation journal claim is corrupt.");
  validateClaim(claim as unknown as HarnessProcessCreationClaim);
  if (value.phase === "claimed") {
    if ("binding" in value) throw new Error("Harness process creation journal record is corrupt.");
    return { phase: "claimed", claim: snapshot(claim) as unknown as HarnessProcessCreationClaim };
  }
  if (!isObject(value.binding))
    throw new Error("Harness process creation journal record is corrupt.");
  return {
    phase: value.phase,
    claim: snapshot(claim) as unknown as HarnessProcessCreationClaim,
    binding: snapshot(value.binding) as unknown as HarnessProcessCreationBinding,
  };
}

function journalKey(runId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(runId)}`;
}

function validateControlBinding(
  claim: HarnessProcessCreationClaim,
  initialization: HarnessDurableStateInitializationInput,
): void {
  if (!sameControllerClaim(claim.controllerClaim, initialization.control))
    throw new Error("Harness process creation initialization uses another controller claim.");
}

async function validateBinding(
  claim: HarnessProcessCreationClaim,
  binding: HarnessProcessCreationBinding,
): Promise<void> {
  if (!UUID.test(binding.nativeSessionId))
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
    const binding = snapshot(candidate);
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
      if (record.binding === undefined || !sameValue(record.binding, binding))
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

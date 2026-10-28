import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";
import {
  readProcessFence,
  sameProcessFence,
  type ProcessFence,
} from "../processOwnership/fence.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessEvictedRecoveryReceipt,
  HarnessProcessFailureCode,
  HarnessProcessFailureRecord,
  HarnessProcessFailureStage,
  HarnessProcessPublicationReceipt,
  HarnessProcessEvictedRecoveryRequest,
  HarnessProcessPlacementIdentity,
  HarnessProcessPlacementRecoveryRecord,
  HarnessProcessPlacementWriter,
} from "./contracts.ts";
export type { HarnessProcessPlacementWriter } from "./contracts.ts";

export const OWNER_KEY = "harness-process-placement-owner-v1";
export const STATE_KEY = "harness-process-slots-v1";
export const RECOVERY_PREFIX = "harness-process-placement-recovery-v1/";
export const EVICTED_RECOVERY_PREFIX = "harness-process-placement-evicted-v1/";
export const WRITER_RELEASE_KEY = "harness-process-placement-writer-release-v1";
export const WRITER_KEY = "harness-process-placement-writer-v1";

const failureMessages: Record<HarnessProcessFailureCode, string> = {
  RPC_FAILED: "Facet RPC failed.",
  IDENTITY_MISMATCH: "The constructed facet identity did not match its lease.",
  STOP_UNACKNOWLEDGED: "Facet stop was not acknowledged.",
  JOIN_INCOMPLETE: "Facet settlement is incomplete.",
  DISPOSE_FAILED: "Facet disposal failed.",
  PUBLICATION_UNCONFIRMED: "Facet publication was not confirmed.",
  PUBLICATION_REQUIRES_REPAIR: "Published process ownership requires explicit repair.",
  INVOCATION_OUTCOME_UNKNOWN:
    "Published process invocation outcome is unknown and requires repair.",
  RECOVERY_UNKNOWN: "Facet recovery could not establish termination.",
};

export function recoveryKey(loaderId: string): string {
  return `${RECOVERY_PREFIX}${encodeURIComponent(loaderId)}`;
}

export function evictedRecoveryKey(
  owner: string,
  sourceFence: ProcessFence,
  identity: HarnessProcessPlacementIdentity,
): string {
  return [
    EVICTED_RECOVERY_PREFIX,
    encodeURIComponent(owner),
    sourceFence.incarnation,
    encodeURIComponent(sourceFence.nonce),
    encodeURIComponent(identity.loaderId),
    encodeURIComponent(identity.incarnationNonce),
  ].join("/");
}

export function parseEvictedRecoveryReceipt(value: unknown): HarnessProcessEvictedRecoveryReceipt {
  if (!isRecord(value)) throw new Error("Evicted process recovery receipt is invalid.");
  let sourceFence: ProcessFence;
  let currentFence: ProcessFence;
  try {
    sourceFence = readProcessFence(value.sourceFence);
    currentFence = readProcessFence(value.currentFence);
  } catch {
    throw new Error("Evicted process recovery receipt has an invalid incarnation fence.");
  }
  const sourceWriter = value.sourceWriter;
  const currentWriter = value.currentWriter;
  const identity = value.identity;
  const lease = value.lease;
  const owner = value.owner;
  const processId = value.processId;
  if (!nonempty(owner) || !nonempty(processId))
    throw new Error("Evicted process recovery receipt lacks its owner identity.");
  if (
    value.version !== 1 ||
    (value.state !== "authorized" && value.state !== "completed") ||
    sourceFence.owner !== owner ||
    currentFence.owner !== owner ||
    sourceFence.incarnation >= currentFence.incarnation ||
    sourceFence.nonce === currentFence.nonce ||
    !isIdentity(identity) ||
    identity.shardOwner !== value.owner ||
    identity.loaderId !== identity.facetKey ||
    !isLease(lease) ||
    lease.loaderId !== identity.loaderId ||
    !isWriter(sourceWriter) ||
    !isWriter(currentWriter) ||
    sourceWriter.shardIncarnationNonce !== sourceFence.nonce ||
    currentWriter.shardIncarnationNonce !== currentFence.nonce ||
    sourceWriter.executionOperationId !== currentWriter.executionOperationId ||
    sourceWriter.shardIndex !== currentWriter.shardIndex ||
    !sameClaim(sourceWriter.controllerClaim, currentWriter.controllerClaim)
  )
    throw new Error("Evicted process recovery receipt does not match its source identity.");
  return {
    version: 1,
    owner,
    sourceFence,
    currentFence,
    sourceWriter,
    currentWriter,
    processId,
    identity,
    lease,
    state: value.state,
  };
}

export function writerIdentityKey(writer: HarnessProcessPlacementWriter): string {
  return [
    writer.executionOperationId,
    writer.shardIndex,
    writer.shardIncarnationNonce,
    writer.controllerClaim.ownerId,
    writer.controllerClaim.incarnationId,
    writer.controllerClaim.epoch,
    writer.controllerClaim.controlKey,
  ].join("\u0000");
}

export function failureRecord(
  stage: HarnessProcessFailureStage,
  code: HarnessProcessFailureCode,
): HarnessProcessFailureRecord {
  return { stage, code, message: failureMessages[code] };
}

export function sameClaim(
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

export function sameWriter(
  left: HarnessProcessPlacementWriter,
  right: HarnessProcessPlacementWriter,
): boolean {
  return (
    left.executionOperationId === right.executionOperationId &&
    left.shardIndex === right.shardIndex &&
    left.shardIncarnationNonce === right.shardIncarnationNonce &&
    sameClaim(left.controllerClaim, right.controllerClaim)
  );
}

export function sameProcessSlotLease(left: ProcessSlotLease, right: ProcessSlotLease): boolean {
  return (
    left.token === right.token &&
    left.loaderId === right.loaderId &&
    left.codeId === right.codeId &&
    left.residentBytes === right.residentBytes
  );
}

export function sameProcessPlacementIdentity(
  left: HarnessProcessPlacementIdentity,
  right: HarnessProcessPlacementIdentity,
): boolean {
  return (
    left.shardOwner === right.shardOwner &&
    left.loaderId === right.loaderId &&
    left.facetKey === right.facetKey &&
    left.incarnationNonce === right.incarnationNonce
  );
}

export function sameEvictedRecoverySource(
  receipt: HarnessProcessEvictedRecoveryReceipt,
  source: Pick<
    HarnessProcessEvictedRecoveryRequest,
    "sourceFence" | "sourceWriter" | "processId" | "identity"
  > & { readonly owner: string },
): boolean {
  return (
    receipt.owner === source.owner &&
    sameProcessFence(receipt.sourceFence, source.sourceFence) &&
    receipt.processId === source.processId &&
    sameWriter(receipt.sourceWriter, source.sourceWriter) &&
    sameProcessPlacementIdentity(receipt.identity, source.identity)
  );
}

export function sameEvictedRecoveryReceipt(
  left: HarnessProcessEvictedRecoveryReceipt,
  right: HarnessProcessEvictedRecoveryReceipt,
): boolean {
  return (
    left.owner === right.owner &&
    sameProcessFence(left.sourceFence, right.sourceFence) &&
    sameProcessFence(left.currentFence, right.currentFence) &&
    sameWriter(left.sourceWriter, right.sourceWriter) &&
    sameWriter(left.currentWriter, right.currentWriter) &&
    left.processId === right.processId &&
    sameProcessPlacementIdentity(left.identity, right.identity) &&
    sameProcessSlotLease(left.lease, right.lease) &&
    left.state === right.state
  );
}

export function assertWriter(value: unknown): asserts value is HarnessProcessPlacementWriter {
  if (!isWriter(value)) throw new TypeError("ProcessSlots writer identity is invalid.");
}

export function parseRecoveryRecord(
  value: unknown,
  owner: string,
): HarnessProcessPlacementRecoveryRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.shardOwner !== owner ||
    !isClaim(value.controllerClaim) ||
    !nonempty(value.operationId) ||
    !nonempty(value.processId) ||
    !nonempty(value.nativeSessionId) ||
    !nonempty(value.checkpointId) ||
    !nonempty(value.manifestRevision) ||
    !nonempty(value.priorFacetNonce) ||
    (value.expectedFacetGeneration !== undefined &&
      (!Number.isSafeInteger(value.expectedFacetGeneration) ||
        Number(value.expectedFacetGeneration) < 0)) ||
    !nonempty(value.programCodeId) ||
    !nonempty(value.loaderId) ||
    value.facetKey !== value.loaderId ||
    (value.incarnationNonce !== undefined && !nonempty(value.incarnationNonce)) ||
    (value.identityState !== undefined &&
      value.identityState !== "unknown" &&
      value.identityState !== "observed") ||
    (value.identityState === "observed" && !nonempty(value.incarnationNonce)) ||
    (value.identityState === "unknown" && value.incarnationNonce !== undefined) ||
    !isLease(value.lease) ||
    value.lease.loaderId !== value.loaderId ||
    !isPlacementState(value.state) ||
    typeof value.stopAcknowledged !== "boolean" ||
    !isJoined(value.joined) ||
    (value.lastFailure !== undefined && !isFailureRecord(value.lastFailure)) ||
    (value.terminalFailure !== undefined && !isFailureRecord(value.terminalFailure)) ||
    (value.publicationState !== undefined && !isPublicationState(value.publicationState)) ||
    (value.publicationReceipt !== undefined && !isPublicationReceipt(value.publicationReceipt)) ||
    (value.publicationState === "confirmed" && value.publicationReceipt === undefined) ||
    (value.invocationMayHaveStarted !== undefined &&
      typeof value.invocationMayHaveStarted !== "boolean") ||
    (value.invocationAttempt !== undefined &&
      (!Number.isSafeInteger(value.invocationAttempt) ||
        Number(value.invocationAttempt) < 1 ||
        value.invocationMayHaveStarted !== true ||
        !nonempty(value.invocationRequestId) ||
        (value.invocationReply !== "unresolved" && value.invocationReply !== "received"))) ||
    (value.invocationRequestId !== undefined && !nonempty(value.invocationRequestId)) ||
    (value.invocationReply !== undefined &&
      value.invocationReply !== "unresolved" &&
      value.invocationReply !== "received") ||
    (value.publicationState !== undefined && value.expectedFacetGeneration === undefined)
  )
    throw new Error("Process-placement recovery record is invalid.");
  return {
    ...value,
    identityState:
      value.identityState === undefined
        ? value.incarnationNonce === undefined
          ? "unknown"
          : "observed"
        : value.identityState,
  } as unknown as HarnessProcessPlacementRecoveryRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWriter(value: unknown): value is HarnessProcessPlacementWriter {
  return (
    isRecord(value) &&
    nonempty(value.executionOperationId) &&
    Number.isSafeInteger(value.shardIndex) &&
    Number(value.shardIndex) >= 0 &&
    nonempty(value.shardIncarnationNonce) &&
    isClaim(value.controllerClaim)
  );
}

function isIdentity(value: unknown): value is HarnessProcessPlacementIdentity {
  return (
    isRecord(value) &&
    nonempty(value.shardOwner) &&
    nonempty(value.loaderId) &&
    nonempty(value.facetKey) &&
    nonempty(value.incarnationNonce)
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isClaim(value: unknown): value is HarnessProcessControllerClaim {
  return (
    isRecord(value) &&
    nonempty(value.ownerId) &&
    nonempty(value.incarnationId) &&
    Number.isSafeInteger(value.epoch) &&
    Number(value.epoch) > 0 &&
    nonempty(value.controlKey)
  );
}

function isLease(value: unknown): value is ProcessSlotLease {
  return (
    isRecord(value) &&
    nonempty(value.token) &&
    nonempty(value.loaderId) &&
    nonempty(value.codeId) &&
    Number.isSafeInteger(value.residentBytes) &&
    Number(value.residentBytes) >= 0
  );
}

function isPlacementState(value: unknown): value is HarnessProcessPlacementRecoveryRecord["state"] {
  return (
    value === "identity-unknown" ||
    value === "preparing" ||
    value === "prepared" ||
    value === "publication-confirmed" ||
    value === "active" ||
    value === "parked" ||
    value === "cleanup-required" ||
    value === "activation-failed"
  );
}

function isPublicationState(
  value: unknown,
): value is NonNullable<HarnessProcessPlacementRecoveryRecord["publicationState"]> {
  return (
    value === "in-progress" ||
    value === "unknown" ||
    value === "pending" ||
    value === "confirmed" ||
    value === "not-published"
  );
}

function isPublicationReceipt(value: unknown): value is HarnessProcessPublicationReceipt {
  if (!isRecord(value) || !isRecord(value.checkpoint)) return false;
  return (
    nonempty(value.operationId) &&
    Number.isSafeInteger(value.fromGeneration) &&
    Number(value.fromGeneration) >= 0 &&
    Number.isSafeInteger(value.toGeneration) &&
    Number(value.toGeneration) === Number(value.fromGeneration) + 1 &&
    nonempty(value.priorFacetNonce) &&
    nonempty(value.preparedFacetNonce) &&
    nonempty(value.checkpoint.checkpointId) &&
    nonempty(value.checkpoint.manifestSha256) &&
    value.status === "confirmed"
  );
}

function isJoined(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.invocationRpc === "boolean" &&
    typeof value.fetch === "boolean" &&
    typeof value.ports === "boolean"
  );
}

function isFailureRecord(value: unknown): value is HarnessProcessFailureRecord {
  if (
    !isRecord(value) ||
    typeof value.stage !== "string" ||
    typeof value.code !== "string" ||
    typeof value.message !== "string"
  )
    return false;
  const expected = failureMessages[value.code as HarnessProcessFailureCode];
  return expected !== undefined && value.message === expected;
}

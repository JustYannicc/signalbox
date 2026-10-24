import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessFailureCode,
  HarnessProcessFailureRecord,
  HarnessProcessFailureStage,
  HarnessProcessPublicationReceipt,
  HarnessProcessPlacementRecoveryRecord,
} from "./contracts.ts";

export const OWNER_KEY = "harness-process-placement-owner-v1";
export const STATE_KEY = "harness-process-slots-v1";
export const RECOVERY_PREFIX = "harness-process-placement-recovery-v1/";
export const WRITER_KEY = "harness-process-placement-writer-v1";

export interface HarnessProcessPlacementWriter {
  readonly executionOperationId: string;
  readonly shardIndex: number;
  readonly shardIncarnationNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
}

const failureMessages: Record<HarnessProcessFailureCode, string> = {
  RPC_FAILED: "Facet RPC failed.",
  IDENTITY_MISMATCH: "The constructed facet identity did not match its lease.",
  STOP_UNACKNOWLEDGED: "Facet stop was not acknowledged.",
  JOIN_INCOMPLETE: "Facet settlement is incomplete.",
  DISPOSE_FAILED: "Facet disposal failed.",
  PUBLICATION_UNCONFIRMED: "Facet publication was not confirmed.",
  PUBLICATION_REQUIRES_REPAIR: "Published process ownership requires explicit repair.",
  RECOVERY_UNKNOWN: "Facet recovery could not establish termination.",
};

export function recoveryKey(loaderId: string): string {
  return `${RECOVERY_PREFIX}${encodeURIComponent(loaderId)}`;
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

export function assertWriter(value: unknown): asserts value is HarnessProcessPlacementWriter {
  if (
    !isRecord(value) ||
    !nonempty(value.executionOperationId) ||
    !Number.isSafeInteger(value.shardIndex) ||
    Number(value.shardIndex) < 0 ||
    !nonempty(value.shardIncarnationNonce) ||
    !isClaim(value.controllerClaim)
  )
    throw new TypeError("ProcessSlots writer identity is invalid.");
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

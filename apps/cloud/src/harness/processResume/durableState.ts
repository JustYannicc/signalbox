import type { HarnessDurableStatePublicationResult } from "../HarnessDurableState.ts";
import type { HarnessProcessPlacementIdentity } from "../processPlacement/contracts.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type {
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeOperationInput,
  HarnessProcessResumePreparedRelease,
} from "./contracts.ts";
import { snapshotHarnessProcessResumeOperation } from "./operation.ts";
import { samePreparedRelease, snapshotPreparedRelease } from "./identity.ts";
import { sameData } from "./checkpointContract.ts";

export interface HarnessProcessResumePlacementPin {
  readonly owner: string;
  readonly executionOperationId: string;
  readonly shardOwner: string;
  readonly shardIndex: number;
  readonly shardIncarnationNonce: string;
}
export interface HarnessProcessResumeDurableRecord {
  readonly version: 1;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly phase:
    | "reserved"
    | "draining"
    | "old-stopped"
    | "prepared"
    | "publication-attempted"
    | "published"
    | "active"
    | "retained";
  readonly placement: HarnessProcessResumePlacementPin;
  readonly terminalKey?: string;
  readonly prepared?: {
    readonly requested: HarnessProcessResumePreparedRelease;
    readonly observed: HarnessProcessResumePreparedRelease;
    readonly publisher: HarnessThreadSupervisorPublisher;
    readonly identity: HarnessProcessPlacementIdentity;
    readonly checkpoint: HarnessProcessResumeCheckpointReference;
  };
  readonly publication?: HarnessDurableStatePublicationResult;
  readonly failure?: { readonly stage: string; readonly reason: string };
}
const phases: readonly HarnessProcessResumeDurableRecord["phase"][] = [
  "reserved",
  "draining",
  "old-stopped",
  "prepared",
  "publication-attempted",
  "published",
  "active",
  "retained",
];
export const harnessProcessResumeDurableKey = (runId: string, operationId: string) =>
  `harness-process-resume/v1/${encodeURIComponent(runId)}/${encodeURIComponent(operationId)}`;
export const activeResumeKey = "harness-process-resume/active";

export async function readHarnessProcessResumeDurableRecord(
  storage: DurableObjectStorage,
  runId: string,
  operationId: string,
) {
  const value = await storage.get<HarnessProcessResumeDurableRecord>(
    harnessProcessResumeDurableKey(runId, operationId),
  );
  if (value === undefined) return undefined;
  validate(value);
  if (value.operation.runId !== runId || value.operation.transition.operationId !== operationId)
    throw new Error("The saved resume attempt belongs to another operation.");
  return value;
}

export async function writeHarnessProcessResumeDurableRecord(
  storage: DurableObjectStorage,
  record: HarnessProcessResumeDurableRecord,
) {
  validate(record);
  const key = harnessProcessResumeDurableKey(
    record.operation.runId,
    record.operation.transition.operationId,
  );
  await storage.transaction(async (transaction) => {
    const existing = await transaction.get<HarnessProcessResumeDurableRecord>(key);
    if (existing !== undefined) {
      validate(existing);
      if (
        !sameData(existing.operation, record.operation) ||
        !sameData(existing.placement, record.placement) ||
        phases.indexOf(record.phase) < phases.indexOf(existing.phase) ||
        (existing.terminalKey !== undefined && existing.terminalKey !== record.terminalKey) ||
        (existing.prepared !== undefined && !sameData(existing.prepared, record.prepared)) ||
        (existing.publication !== undefined && !sameData(existing.publication, record.publication))
      )
        throw new Error("The saved resume attempt conflicts with its immutable evidence.");
    }
    await transaction.put(key, record);
    await transaction.put(activeResumeKey, {
      runId: record.operation.runId,
      operationId: record.operation.transition.operationId,
      phase: record.phase,
    });
  });
}

function validate(record: HarnessProcessResumeDurableRecord) {
  const operation = snapshotHarnessProcessResumeOperation(record?.operation);
  if (
    record?.version !== 1 ||
    operation === undefined ||
    !sameData(operation, record.operation) ||
    !phases.includes(record.phase) ||
    !record.placement?.owner ||
    !record.placement.executionOperationId ||
    !record.placement.shardOwner ||
    !record.placement.shardIncarnationNonce ||
    !Number.isSafeInteger(record.placement.shardIndex) ||
    record.placement.shardIndex < 0
  )
    throw new Error("The saved resume attempt is malformed.");
  const prepared = record.prepared;
  if (
    prepared !== undefined &&
    (snapshotPreparedRelease(prepared.observed) === undefined ||
      !samePreparedRelease(prepared.requested, operation.transition.targetPreparedRelease) ||
      !samePreparedRelease(prepared.observed, prepared.requested) ||
      prepared.publisher.generation !== operation.transition.expectedFacetGeneration + 1 ||
      prepared.publisher.facetNonce !== prepared.identity.incarnationNonce ||
      !prepared.publisher.publisherKey ||
      prepared.identity.shardOwner !== record.placement.owner ||
      !prepared.identity.loaderId ||
      prepared.identity.loaderId !== prepared.identity.facetKey ||
      !prepared.checkpoint.nativeSessionId ||
      !prepared.checkpoint.checkpointId ||
      !prepared.checkpoint.manifestSha256)
  )
    throw new Error("The saved prepared release or placement binding is malformed.");
  if (
    ["prepared", "publication-attempted", "published", "active"].includes(record.phase) &&
    prepared === undefined
  )
    throw new Error("The saved resume attempt has no complete prepared identity.");
}

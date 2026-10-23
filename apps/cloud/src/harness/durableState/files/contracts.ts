import * as Schema from "effect/Schema";
import {
  digest,
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
  id,
  positive,
} from "../shared.ts";

const Control = HarnessThreadSupervisorControlClaim;
const Publisher = HarnessThreadSupervisorPublisher;
const CheckpointRef = Schema.Struct({ checkpointId: id, manifestSha256: digest });
const PublicationReceiptFields = {
  operationId: id,
  fromGeneration: positive,
  toGeneration: positive,
  priorFacetNonce: id,
  preparedFacetNonce: id,
  checkpoint: CheckpointRef,
};
const PublicationReceipt = Schema.Struct(PublicationReceiptFields);
const Publication = Schema.Struct({
  ...PublicationReceiptFields,
  status: Schema.Literals(["pending", "confirmed"]),
});
const AdmissionResolution = Schema.Struct({
  evidenceId: id,
  stepId: Schema.NullOr(id),
  outcome: Schema.Literals(["notApplied", "completed"]),
  expectedCheckpoint: CheckpointRef,
  checkpoint: CheckpointRef,
});

export const HarnessFilesStoreFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  mode: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(4095),
  ),
  bytes: Schema.Uint8Array,
});
export type HarnessFilesStoreFile = typeof HarnessFilesStoreFile.Type;

export const HarnessFilesCheckpoint = Schema.Struct({
  checkpointId: id,
  parentCheckpointId: Schema.NullOr(id),
  files: Schema.Array(HarnessFilesStoreFile),
});
export type HarnessFilesCheckpoint = typeof HarnessFilesCheckpoint.Type;

export const HarnessFilesStoreCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("initialize"),
    runId: id,
    control: Control,
    publisher: Publisher,
    checkpoint: HarnessFilesCheckpoint,
  }),
  Schema.Struct({
    type: Schema.Literal("syncControl"),
    runId: id,
    control: Control,
    fromEpoch: positive,
    fromIncarnationId: id,
    expectedGeneration: positive,
    operationId: id,
    publication: Schema.NullOr(PublicationReceipt),
    preparedPublication: Schema.NullOr(PublicationReceipt),
  }),
  Schema.Struct({
    type: Schema.Literal("admitStep"),
    runId: id,
    publisher: Publisher,
    stepId: id,
    expectedCheckpointId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("reconcileAdmission"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    evidenceId: id,
    stepId: Schema.NullOr(id),
    outcome: Schema.Literals(["notApplied", "completed"]),
    expectedCheckpoint: CheckpointRef,
    checkpoint: Schema.NullOr(CheckpointRef),
  }),
  Schema.Struct({
    type: Schema.Literal("writeCheckpoint"),
    runId: id,
    publisher: Publisher,
    stepId: id,
    expectedCheckpointId: id,
    checkpoint: HarnessFilesCheckpoint,
  }),
  Schema.Struct({
    type: Schema.Literal("readCheckpoint"),
    runId: id,
    publisher: Publisher,
    checkpointId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("recoverCheckpoint"),
    runId: id,
    publisher: Publisher,
    checkpointId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("publishFacet"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    preparedPublisher: Publisher,
    operationId: id,
    checkpoint: CheckpointRef,
  }),
  Schema.Struct({
    type: Schema.Literal("confirmFacetPublication"),
    runId: id,
    control: Control,
    expectedGeneration: positive,
    preparedPublisher: Publisher,
    operationId: id,
    checkpoint: CheckpointRef,
  }),
  Schema.Struct({
    type: Schema.Literal("abortFacetPublication"),
    runId: id,
    control: Control,
    expectedGeneration: positive,
    preparedPublisher: Publisher,
    operationId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("readPublication"),
    runId: id,
    control: Control,
    operationId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("recordActivation"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("recordActivationFailure"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
  }),
]);
export type HarnessFilesStoreCommand = typeof HarnessFilesStoreCommand.Type;

export const HarnessFilesPublication = Publication;
export type HarnessFilesPublication = typeof HarnessFilesPublication.Type;

export const HarnessFilesStoreResult = Schema.Struct({
  action: Schema.Literals([
    "recorded",
    "unchanged",
    "admitted",
    "reconciled",
    "read",
    "recovered",
    "prepared",
    "confirmed",
    "aborted",
    "pending",
    "draining",
    "activated",
    "activation-failed",
  ]),
  checkpoint: CheckpointRef,
  parentCheckpointId: Schema.NullOr(id),
  activeStepId: Schema.NullOr(id),
  admissionResolution: Schema.NullOr(AdmissionResolution),
  publication: Schema.NullOr(HarnessFilesPublication),
  files: Schema.Array(HarnessFilesStoreFile),
});
export type HarnessFilesStoreResult = typeof HarnessFilesStoreResult.Type;

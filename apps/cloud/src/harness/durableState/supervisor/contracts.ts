import * as Schema from "effect/Schema";
import {
  capability,
  digest,
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
  id,
  positive,
} from "../shared.ts";

const Control = HarnessThreadSupervisorControlClaim;
const Publisher = HarnessThreadSupervisorPublisher;
const NextControl = Schema.Struct({
  ownerId: id,
  incarnationId: id,
  epoch: positive,
  controlKey: capability,
});
export const Checkpoint = Schema.Struct({ checkpointId: id, manifestSha256: digest });
export const Cleanup = Schema.Struct({
  stopAcknowledged: Schema.Boolean,
  invocationRpcJoined: Schema.Boolean,
  fetchJoined: Schema.Boolean,
  callbackPortsJoined: Schema.Boolean,
  disposed: Schema.Boolean,
});
export const InvocationSettlementEvidence = Schema.Struct({
  invocationRpcJoined: Schema.Boolean,
  fetchJoined: Schema.Boolean,
  callbackPortsJoined: Schema.Boolean,
});
const Failure = Schema.Struct({ kind: id, message: id });
const Publication = Schema.Struct({
  operationId: id,
  fromGeneration: positive,
  toGeneration: positive,
  priorFacetNonce: id,
  preparedFacetNonce: id,
  checkpoint: Checkpoint,
});
const PreparedPublication = Publication;
export const AdmissionResolution = Schema.Struct({
  evidenceId: id,
  stepId: Schema.NullOr(id),
  outcome: Schema.Literals(["notApplied", "completed"]),
  expectedCheckpoint: Checkpoint,
  checkpoint: Checkpoint,
});
const ReconciliationEvidence = {
  expectedGeneration: positive,
  evidenceId: id,
  outcome: Schema.Literals(["notApplied", "completed", "unknown"]),
  checkpoint: Schema.NullOr(Checkpoint),
  invocationSettlement: Schema.NullOr(InvocationSettlementEvidence),
  preparedFacetCleanup: Schema.NullOr(Cleanup),
};

export const HarnessThreadSupervisorCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("initialize"),
    runId: id,
    nativeSessionId: id,
    control: Control,
    publisher: Publisher,
    checkpoint: Checkpoint,
  }),
  Schema.Struct({ type: Schema.Literal("read"), runId: id, control: Control }),
  Schema.Struct({
    type: Schema.Literal("beginDrain"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
    nextControl: NextControl,
  }),
  Schema.Struct({
    type: Schema.Literal("confirmControlSync"),
    runId: id,
    control: Control,
    fromEpoch: positive,
    fromIncarnationId: id,
    expectedGeneration: positive,
    operationId: id,
    publication: Schema.NullOr(Publication),
    preparedPublication: Schema.NullOr(PreparedPublication),
  }),
  Schema.Struct({
    type: Schema.Literal("admitStep"),
    runId: id,
    publisher: Publisher,
    stepId: id,
    expectedCheckpointId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("commitCheckpoint"),
    runId: id,
    publisher: Publisher,
    stepId: id,
    expectedCheckpointId: id,
    checkpoint: Checkpoint,
  }),
  Schema.Struct({
    type: Schema.Literal("recordStopAcknowledgement"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    requestId: id,
    acknowledgementId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("settleInvocation"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    outcome: Schema.Literals(["settled", "stopped", "indeterminate"]),
    invocationRpcJoined: Schema.Boolean,
    fetchJoined: Schema.Boolean,
    callbackPortsJoined: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("prepareFreshFacet"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
    preparedPublisher: Publisher,
  }),
  Schema.Struct({
    type: Schema.Literal("publishFreshFacet"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
    preparedPublisher: Publisher,
    verifiedNativeSessionId: id,
    checkpoint: Checkpoint,
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
    failure: Failure,
  }),
  Schema.Struct({
    type: Schema.Literal("recordPreparedFacetFailure"),
    runId: id,
    control: Control,
    publisher: Publisher,
    expectedGeneration: positive,
    operationId: id,
    phase: Schema.Literals(["prepare", "publish"]),
    preparedPublisher: Publisher,
    failure: Failure,
    cleanup: Cleanup,
  }),
  Schema.Struct({
    type: Schema.Literal("reconcile"),
    runId: id,
    control: Control,
    ...ReconciliationEvidence,
    admissionResolution: Schema.NullOr(AdmissionResolution),
  }),
]);
export type HarnessThreadSupervisorCommand = typeof HarnessThreadSupervisorCommand.Type;

export const PreparedFacet = Schema.Struct({
  operationId: id,
  generation: positive,
  facetNonce: id,
  checkpoint: Checkpoint,
});
const LastFailure = Schema.Struct({
  phase: Schema.Literals(["prepare", "publish", "activate"]),
  operationId: id,
  failure: Failure,
  cleanup: Schema.NullOr(Cleanup),
});
const ControlSync = Schema.Struct({
  operationId: id,
  fromEpoch: positive,
  fromIncarnationId: id,
  toEpoch: positive,
  toIncarnationId: id,
  expectedGeneration: positive,
  publication: Schema.NullOr(Publication),
  preparedPublication: Schema.NullOr(PreparedPublication),
});
const Settlement = Schema.Struct({
  outcome: Schema.Literals(["settled", "stopped", "indeterminate"]),
  invocationRpcJoined: Schema.Boolean,
  fetchJoined: Schema.Boolean,
  callbackPortsJoined: Schema.Boolean,
});
export const HarnessThreadSupervisorSnapshot = Schema.Struct({
  runId: id,
  ownerId: id,
  controlIncarnationId: id,
  controlEpoch: positive,
  nativeSessionId: id,
  checkpoint: Checkpoint,
  generation: positive,
  facetNonce: id,
  lifecycle: Schema.Literals([
    "accepting",
    "draining",
    "settled",
    "stopped",
    "indeterminate",
    "preparing",
    "published",
    "activation-failed",
    "recoverable",
  ]),
  admittedStepId: Schema.NullOr(id),
  preparedFacet: Schema.NullOr(PreparedFacet),
  lastPublication: Schema.NullOr(Publication),
  pendingControlSync: Schema.NullOr(ControlSync),
  lastPublicationOperationId: Schema.NullOr(id),
  stopAcknowledgementId: Schema.NullOr(id),
  settlement: Schema.NullOr(Settlement),
  lastFailure: Schema.NullOr(LastFailure),
  reconciliationEvidenceId: Schema.NullOr(id),
  reconciliationExpectedGeneration: Schema.NullOr(positive),
  reconciliationAdmissionResolution: Schema.NullOr(AdmissionResolution),
  reconciliationOutcome: Schema.NullOr(Schema.Literals(["notApplied", "completed", "unknown"])),
  reconciliationCheckpoint: Schema.NullOr(Checkpoint),
  reconciliationInvocationSettlement: Schema.NullOr(InvocationSettlementEvidence),
  reconciliationPreparedFacetCleanup: Schema.NullOr(Cleanup),
});
export type HarnessThreadSupervisorSnapshot = typeof HarnessThreadSupervisorSnapshot.Type;

export const HarnessThreadSupervisorResult = Schema.Struct({
  action: Schema.Literals([
    "recorded",
    "unchanged",
    "admitted",
    "checkpointed",
    "draining",
    "control-synced",
    "settled",
    "stopped",
    "indeterminate",
    "prepared",
    "published",
    "activated",
    "activation-failed",
    "recoverable",
    "reconciled",
  ]),
  snapshot: HarnessThreadSupervisorSnapshot,
  currentPublisher: Publisher,
  preparedPublisher: Schema.NullOr(Publisher),
});
export type HarnessThreadSupervisorResult = typeof HarnessThreadSupervisorResult.Type;

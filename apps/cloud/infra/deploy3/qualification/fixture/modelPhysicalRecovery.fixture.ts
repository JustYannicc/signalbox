import { equals as sameData } from "effect/Equal";
import {
  verifyCreationRetirement,
  type CreationRetirementEvidence,
} from "./modelCreationRetirement.fixture.ts";
import type { HarnessRequestCheckpoint } from "../../../../src/harness/HarnessRunStore.ts";
import type {
  HarnessProcessPlacementIdentity,
  HarnessProcessPlacementRecoveryRecord,
  HarnessProcessPlacementWriter,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import {
  parseEvictedRecoveryReceipt,
  parseRecoveryRecord,
} from "../../../../src/harness/HarnessProcessPlacementEvidence.ts";
type HarnessProcessEvictedRecoveryReceipt = ReturnType<typeof parseEvictedRecoveryReceipt>;
type ProcessFence = HarnessProcessEvictedRecoveryReceipt["sourceFence"];
type CreationRetirement = ReturnType<typeof verifyCreationRetirement>;

export interface ModelPhysicalIdentity {
  readonly incarnation: string;
  readonly loaderId: string;
}

export interface ModelRecoveryBoundary {
  readonly runId: string;
  readonly processId: string;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly phase: string;
  readonly fence: ProcessFence;
  readonly writer: HarnessProcessPlacementWriter;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly generation: number;
}

export interface ModelRecoveryEvidence {
  readonly boundary: ModelRecoveryBoundary;
  readonly currentFence: ProcessFence;
  readonly history: readonly ProcessFence[];
  readonly candidate: HarnessProcessPlacementRecoveryRecord;
  readonly retirement: HarnessProcessEvictedRecoveryReceipt | CreationRetirement;
  readonly creation?: CreationRetirementEvidence;
}

export interface ModelRecoveryExpectation {
  readonly owner: string;
  readonly runId: string;
  readonly processId: string;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly controllerClaim: HarnessProcessPlacementWriter["controllerClaim"];
  readonly from: ModelPhysicalIdentity;
  readonly to: ModelPhysicalIdentity;
}

export function assertLiveModelRecoveryCandidate(candidate: HarnessProcessPlacementRecoveryRecord) {
  // The placement producer omits invocation fields until invocation starts.
  if (
    candidate.state !== "preparing" ||
    candidate.identityState !== "observed" ||
    candidate.stopAcknowledged !== false ||
    candidate.invocationMayHaveStarted === true ||
    candidate.invocationAttempt !== undefined ||
    candidate.invocationRequestId !== undefined ||
    candidate.invocationReply !== undefined ||
    candidate.publicationState !== undefined ||
    candidate.publicationReceipt !== undefined ||
    candidate.lastFailure !== undefined ||
    candidate.terminalFailure !== undefined ||
    Object.values(candidate.joined).some(Boolean)
  )
    throw new Error(
      "Physical model recovery must precede invocation, publication, failure and stop.",
    );
}

export async function collectModelPhysicalRecovery(
  owner: string,
  target: ModelPhysicalIdentity,
  source: Omit<ModelRecoveryEvidence, "candidate" | "retirement"> | undefined,
  placement: {
    readWriter(owner: string): Promise<HarnessProcessPlacementWriter | undefined>;
    listRecovery(
      owner: string,
      writer: HarnessProcessPlacementWriter,
    ): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
    writerReleased(owner: string, writer: HarnessProcessPlacementWriter): Promise<boolean>;
    readEvictedRecovery(
      owner: string,
      fence: ProcessFence,
      identity: HarnessProcessPlacementIdentity,
    ): Promise<HarnessProcessEvictedRecoveryReceipt | undefined>;
  },
): Promise<ModelRecoveryEvidence | undefined> {
  if (!source || source.boundary.phase !== "restoring") return undefined;
  const writer = await placement.readWriter(owner);
  if (!writer || writer.shardIncarnationNonce !== source.currentFence.nonce)
    throw new Error("Physical recovery has no current placement writer.");
  const records = await placement.listRecovery(owner, writer);
  const matches = records.filter(
    (row) => row.loaderId === target.loaderId && row.incarnationNonce === target.incarnation,
  );
  if (matches.length !== 1) throw new Error("Physical recovery candidate is missing or ambiguous.");
  const candidate = matches[0]!;
  assertLiveModelRecoveryCandidate(candidate);
  const published = await placement.readEvictedRecovery(
    owner,
    source.boundary.fence,
    source.boundary.identity,
  );
  const releaseWriter = source.creation?.placement.releaseWriter;
  if (!published && source.creation && !releaseWriter)
    throw new Error("Creation retirement has no durable releasing writer.");
  const retirement =
    published ??
    (source.creation &&
      releaseWriter &&
      verifyCreationRetirement({
        owner,
        writer: releaseWriter,
        currentFence: source.currentFence,
        history: source.history,
        creation: source.creation,
        completed: true,
        writerReleased: await placement.writerReleased(owner, releaseWriter),
      }));
  if (retirement?.state !== "completed")
    throw new Error("Physical recovery lacks a completed durable retirement.");
  return { ...source, candidate, retirement };
}

export function verifyModelPhysicalRecovery(
  expected: ModelRecoveryExpectation,
  evidence: ModelRecoveryEvidence,
) {
  const { boundary, currentFence, history } = evidence;
  const candidate = parseRecoveryRecord(evidence.candidate, evidence.currentFence.owner);
  const retirement =
    "kind" in evidence.retirement
      ? verifyCreationRetirement({
          owner: expected.owner,
          writer: evidence.retirement.currentWriter,
          currentFence,
          history,
          creation: evidence.retirement.creation,
          completed: true,
          writerReleased: evidence.retirement.writerReleased,
        })
      : parseEvictedRecoveryReceipt(evidence.retirement);
  const assertBound = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  assertBound(
    boundary.runId === expected.runId &&
      boundary.processId === expected.processId &&
      boundary.nativeSessionId === expected.nativeSessionId &&
      boundary.identity.shardOwner === expected.owner &&
      sameData(boundary.writer.controllerClaim, expected.controllerClaim) &&
      sameData(boundary.checkpoint, expected.checkpoint),
    "Model recovery changed its logical native session or committed checkpoint.",
  );
  if ("kind" in retirement)
    assertBound(
      retirement.nativeSessionId === expected.nativeSessionId &&
        sameData(retirement.checkpoint, expected.checkpoint) &&
        boundary.generation === 1,
      "Initial physical recovery changed the creation native checkpoint.",
    );
  assertBound(
    boundary.identity.incarnationNonce === expected.from.incarnation &&
      boundary.identity.loaderId === expected.from.loaderId &&
      expected.to.incarnation !== expected.from.incarnation &&
      expected.to.loaderId !== expected.from.loaderId,
    "Model recovery does not replace the exact destroyed physical parent.",
  );
  assertBound(
    currentFence.owner === expected.owner &&
      currentFence.owner === boundary.fence.owner &&
      currentFence.incarnation > boundary.fence.incarnation &&
      currentFence.nonce !== boundary.fence.nonce &&
      history.some((fence) => sameData(fence, boundary.fence)) &&
      history.some((fence) => sameData(fence, currentFence)),
    "Model recovery lacks an observed newer parent fence.",
  );
  assertBound(
    retirement.state === "completed" &&
      retirement.owner === currentFence.owner &&
      retirement.processId === expected.processId &&
      sameData(retirement.sourceFence, boundary.fence) &&
      sameData(retirement.currentFence, currentFence) &&
      sameData(retirement.sourceWriter, boundary.writer) &&
      sameData(retirement.identity, boundary.identity) &&
      retirement.lease.loaderId === expected.from.loaderId,
    "Model recovery lacks the exact completed physical retirement.",
  );
  assertBound(
    retirement.currentWriter.executionOperationId === boundary.writer.executionOperationId &&
      retirement.currentWriter.shardIndex === boundary.writer.shardIndex &&
      retirement.currentWriter.shardIncarnationNonce === currentFence.nonce &&
      sameData(retirement.currentWriter.controllerClaim, boundary.writer.controllerClaim),
    "Model recovery retirement transferred another logical controller.",
  );
  assertBound(
    candidate.operationId ===
      `eviction-restore-${currentFence.incarnation}-${currentFence.nonce}` &&
      candidate.shardOwner === currentFence.owner &&
      candidate.processId === expected.processId &&
      candidate.nativeSessionId === expected.nativeSessionId &&
      candidate.checkpointId === expected.checkpoint.native.id &&
      candidate.manifestRevision === expected.checkpoint.filesystem.sha256 &&
      candidate.priorFacetNonce === expected.from.incarnation &&
      candidate.expectedFacetGeneration === boundary.generation &&
      candidate.loaderId === expected.to.loaderId &&
      candidate.facetKey === expected.to.loaderId &&
      candidate.incarnationNonce === expected.to.incarnation &&
      sameData(candidate.controllerClaim, boundary.writer.controllerClaim),
    "Model recovery candidate changed the native checkpoint or physical identity.",
  );
  return {
    nativeSessionId: expected.nativeSessionId,
    checkpoint: expected.checkpoint,
    from: expected.from,
    to: expected.to,
    retirement,
  };
}

export interface ModelSocketDrain {
  readonly incarnation: string;
  readonly socketCount: number;
  readonly alreadyClosed: number;
  readonly closedAndJoined: boolean;
}

export interface ModelPhysicalRecoveryInput<Receipt> {
  readonly fromIncarnation: string;
  readonly toIncarnation: string;
  readonly nativeSessionId: string;
  readonly checkpoint: unknown;
  readonly receipt: Receipt;
}

export async function recoverModelPhysicalIncarnation<Receipt>(
  input: ModelPhysicalRecoveryInput<Receipt>,
  owner: {
    readonly nativeSessionId: string;
    readonly currentIncarnation: string | undefined;
    readonly preparedIncarnation: string | undefined;
    readonly activeTurnIncarnation: string | undefined;
    readonly logicalReplacementCount: number;
    readonly physicalOrdinals: ReadonlyMap<string, number>;
    readonly logicalIncarnations: ReadonlyMap<string, number>;
  },
  verify: (input: ModelPhysicalRecoveryInput<Receipt>) => Promise<{
    readonly durable: boolean;
    readonly retirementCompleted: boolean;
    readonly nativeSessionId: string;
    readonly checkpoint: unknown;
  }>,
  closeAndJoin: (incarnation: string) => Promise<ModelSocketDrain>,
) {
  if (
    input.nativeSessionId !== owner.nativeSessionId ||
    input.fromIncarnation !== owner.currentIncarnation ||
    input.fromIncarnation !== owner.preparedIncarnation ||
    input.toIncarnation.length === 0 ||
    owner.physicalOrdinals.has(input.toIncarnation) ||
    (owner.activeTurnIncarnation !== undefined &&
      owner.activeTurnIncarnation !== input.fromIncarnation)
  )
    throw new Error("Physical recovery changed the current logical model owner.");
  const logicalIncarnation = owner.logicalIncarnations.get(input.fromIncarnation);
  if (
    (logicalIncarnation !== 0 && logicalIncarnation !== 1) ||
    logicalIncarnation !== owner.logicalReplacementCount
  )
    throw new Error("Physical recovery lost its logical generation.");
  const verification = await verify(input);
  if (
    verification.durable !== true ||
    verification.retirementCompleted !== true ||
    verification.nativeSessionId !== owner.nativeSessionId ||
    !sameData(verification.checkpoint, input.checkpoint)
  )
    throw new Error("Physical recovery lacks the exact durable retirement and checkpoint proof.");
  const modelSocketDrain = await closeAndJoin(input.fromIncarnation);
  if (
    modelSocketDrain.incarnation !== input.fromIncarnation ||
    modelSocketDrain.closedAndJoined !== true
  )
    throw new Error("Prior physical model sockets did not drain.");
  return {
    ...input,
    logicalIncarnation,
    ordinal: owner.physicalOrdinals.size + 1,
    modelSocketDrain,
    verification,
  };
}

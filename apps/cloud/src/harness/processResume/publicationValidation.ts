import type { HarnessDurableStatePublicationResult } from "../HarnessDurableState.ts";
import type {
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeInput,
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult,
} from "./contracts.ts";

const sameCheckpoint = (
  left: { readonly checkpointId: string; readonly manifestSha256: string },
  right: { readonly checkpointId: string; readonly manifestSha256: string },
) => left.checkpointId === right.checkpointId && left.manifestSha256 === right.manifestSha256;

export const matchesControl = (
  publication: Extract<HarnessProcessResumePublicationResult, { readonly status: "published" }>,
  control: HarnessProcessResumeInput["nextControl"],
) =>
  publication.control.ownerId === control.ownerId &&
  publication.control.incarnationId === control.incarnationId &&
  publication.control.epoch === control.epoch &&
  publication.control.controlKey === control.controlKey;

const sameReceipt = (
  left: NonNullable<
    Extract<HarnessDurableStatePublicationResult, { status: "published" }>["receipt"]
  >,
  right: NonNullable<
    Extract<HarnessDurableStatePublicationResult, { status: "published" }>["receipt"]
  >,
) =>
  left.status === "confirmed" &&
  right.status === "confirmed" &&
  left.operationId === right.operationId &&
  left.fromGeneration === right.fromGeneration &&
  left.toGeneration === right.toGeneration &&
  left.priorFacetNonce === right.priorFacetNonce &&
  left.preparedFacetNonce === right.preparedFacetNonce &&
  sameCheckpoint(left.checkpoint, right.checkpoint);

export const matchesConfirmedPublication = <
  Checkpoint extends HarnessProcessResumeCheckpointReference,
  PreparedFacet extends HarnessProcessResumePreparedFacet,
>(
  publication: Extract<HarnessDurableStatePublicationResult, { readonly status: "published" }>,
  input: HarnessProcessResumeInput,
  checkpoint: Checkpoint,
  nativeSessionId: string,
  prepared: PreparedFacet,
) => {
  const { receipt, files, supervisor } = publication;
  const { snapshot, currentPublisher } = supervisor;
  const last = snapshot.lastPublication;
  const expectedCheckpoint = {
    checkpointId: checkpoint.checkpointId,
    manifestSha256: checkpoint.manifestSha256,
  };
  const expectedGeneration = input.expectedFacetGeneration + 1;

  return (
    input.publisher.generation === input.expectedFacetGeneration &&
    receipt.status === "confirmed" &&
    receipt.operationId === input.operationId &&
    receipt.fromGeneration === input.expectedFacetGeneration &&
    receipt.toGeneration === expectedGeneration &&
    receipt.priorFacetNonce === input.publisher.facetNonce &&
    receipt.preparedFacetNonce === prepared.identity.incarnationNonce &&
    sameCheckpoint(receipt.checkpoint, expectedCheckpoint) &&
    files.publication !== null &&
    sameReceipt(files.publication, receipt) &&
    sameCheckpoint(files.checkpoint, expectedCheckpoint) &&
    snapshot.lifecycle === "published" &&
    snapshot.ownerId === input.nextControl.ownerId &&
    snapshot.controlIncarnationId === input.nextControl.incarnationId &&
    snapshot.controlEpoch === input.nextControl.epoch &&
    snapshot.nativeSessionId === nativeSessionId &&
    sameCheckpoint(snapshot.checkpoint, expectedCheckpoint) &&
    snapshot.generation === expectedGeneration &&
    snapshot.facetNonce === prepared.identity.incarnationNonce &&
    snapshot.lastPublicationOperationId === input.operationId &&
    last !== null &&
    last.operationId === input.operationId &&
    last.fromGeneration === input.expectedFacetGeneration &&
    last.toGeneration === expectedGeneration &&
    last.priorFacetNonce === input.publisher.facetNonce &&
    last.preparedFacetNonce === prepared.identity.incarnationNonce &&
    sameCheckpoint(last.checkpoint, expectedCheckpoint) &&
    currentPublisher.generation === expectedGeneration &&
    currentPublisher.facetNonce === prepared.identity.incarnationNonce &&
    currentPublisher.publisherKey.length > 0
  );
};

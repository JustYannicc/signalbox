import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementIdentity,
  HarnessProcessPublication,
  HarnessProcessPublicationReceipt,
} from "./contracts.ts";

export interface HarnessProcessPublicationExpectation {
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
  readonly identity: HarnessProcessPlacementIdentity;
}

/** Check the exact composed receipt against the durable state captured before preparation. */
export function confirmedProcessPublication(
  publication: HarnessProcessPublication,
  expected: HarnessProcessPublicationExpectation,
): HarnessProcessPublicationReceipt | undefined {
  if (
    publication.status !== "published" ||
    publication.receipt == null ||
    publication.files?.publication == null ||
    publication.supervisor == null
  )
    return undefined;
  const { receipt, files, supervisor } = publication;
  if (receipt === undefined || files?.publication === undefined || supervisor === undefined)
    return undefined;
  const { snapshot, currentPublisher } = supervisor;
  const nextGeneration = expected.expectedFacetGeneration + 1;
  const checkpoint = {
    checkpointId: expected.checkpointId,
    manifestSha256: expected.manifestRevision,
  };

  if (
    receipt.status !== "confirmed" ||
    files.publication?.status !== "confirmed" ||
    !sameReceipt(receipt, files.publication) ||
    receipt.operationId !== expected.operationId ||
    receipt.fromGeneration !== expected.expectedFacetGeneration ||
    receipt.toGeneration !== nextGeneration ||
    receipt.priorFacetNonce !== expected.priorFacetNonce ||
    receipt.preparedFacetNonce !== expected.identity.incarnationNonce ||
    receipt.checkpoint.checkpointId !== expected.checkpointId ||
    receipt.checkpoint.manifestSha256 !== expected.manifestRevision ||
    snapshot.lifecycle !== "published" ||
    snapshot.ownerId !== expected.controllerClaim.ownerId ||
    snapshot.controlIncarnationId !== expected.controllerClaim.incarnationId ||
    snapshot.controlEpoch !== expected.controllerClaim.epoch ||
    snapshot.nativeSessionId !== expected.nativeSessionId ||
    snapshot.generation !== nextGeneration ||
    snapshot.facetNonce !== expected.identity.incarnationNonce ||
    snapshot.lastPublicationOperationId !== expected.operationId ||
    !sameCheckpoint(snapshot.checkpoint, checkpoint) ||
    snapshot.lastPublication === null ||
    snapshot.lastPublication.operationId !== expected.operationId ||
    snapshot.lastPublication.fromGeneration !== expected.expectedFacetGeneration ||
    snapshot.lastPublication.toGeneration !== nextGeneration ||
    snapshot.lastPublication.priorFacetNonce !== expected.priorFacetNonce ||
    snapshot.lastPublication.preparedFacetNonce !== expected.identity.incarnationNonce ||
    !sameCheckpoint(snapshot.lastPublication.checkpoint, checkpoint) ||
    currentPublisher.generation !== nextGeneration ||
    currentPublisher.facetNonce !== expected.identity.incarnationNonce
  )
    return undefined;

  return receipt;
}

function sameReceipt(
  left: HarnessProcessPublicationReceipt,
  right: HarnessProcessPublicationReceipt,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.fromGeneration === right.fromGeneration &&
    left.toGeneration === right.toGeneration &&
    left.priorFacetNonce === right.priorFacetNonce &&
    left.preparedFacetNonce === right.preparedFacetNonce &&
    left.status === right.status &&
    sameCheckpoint(left.checkpoint, right.checkpoint)
  );
}

function sameCheckpoint(
  left: { readonly checkpointId: string; readonly manifestSha256: string },
  right: { readonly checkpointId: string; readonly manifestSha256: string },
): boolean {
  return left.checkpointId === right.checkpointId && left.manifestSha256 === right.manifestSha256;
}

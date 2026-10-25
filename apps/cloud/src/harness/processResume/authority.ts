import type {
  HarnessDurableState,
  HarnessDurableStatePublicationResult,
} from "../HarnessDurableState.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type {
  HarnessProcessPublicationReceipt,
  HarnessProcessPublicationRequest,
} from "../processPlacement/contracts.ts";

export type Published = Extract<HarnessDurableStatePublicationResult, { status: "published" }>;
export const sameControl = (
  a: HarnessThreadSupervisorControlClaim,
  b: HarnessThreadSupervisorControlClaim,
) =>
  a.ownerId === b.ownerId &&
  a.incarnationId === b.incarnationId &&
  a.epoch === b.epoch &&
  a.controlKey === b.controlKey;
export const samePublisher = (
  a: HarnessThreadSupervisorPublisher,
  b: HarnessThreadSupervisorPublisher,
) =>
  a.generation === b.generation &&
  a.facetNonce === b.facetNonce &&
  a.publisherKey === b.publisherKey;
export const sameReference = (
  a: { checkpointId: string; manifestSha256: string },
  b: { checkpointId: string; manifestSha256: string },
) => a.checkpointId === b.checkpointId && a.manifestSha256 === b.manifestSha256;
export function sameReceipt(
  a: Omit<HarnessProcessPublicationReceipt, "status"> | null | undefined,
  b: HarnessProcessPublicationReceipt,
) {
  return (
    a != null &&
    a.operationId === b.operationId &&
    a.fromGeneration === b.fromGeneration &&
    a.toGeneration === b.toGeneration &&
    a.priorFacetNonce === b.priorFacetNonce &&
    a.preparedFacetNonce === b.preparedFacetNonce &&
    sameReference(a.checkpoint, b.checkpoint)
  );
}

export async function authorizePublication(input: {
  readonly durable: HarnessDurableState;
  readonly runId: string;
  readonly publication: Published;
  readonly request: HarnessProcessPublicationRequest;
  readonly lifecycle: "published" | "accepting";
}) {
  const { durable, runId, publication, request } = input;
  const receipt = publication.receipt;
  if (
    !sameControl(publication.control, request.controllerClaim) ||
    receipt.status !== "confirmed" ||
    receipt.operationId !== request.operationId ||
    receipt.fromGeneration !== request.expectedFacetGeneration ||
    receipt.toGeneration !== request.expectedFacetGeneration + 1 ||
    receipt.priorFacetNonce !== request.priorFacetNonce ||
    receipt.preparedFacetNonce !== request.identity.incarnationNonce ||
    receipt.checkpoint.checkpointId !== request.checkpointId ||
    receipt.checkpoint.manifestSha256 !== request.manifestRevision
  )
    throw new Error("The publication does not match the owned process.");
  const files = await durable.readPublication({
    control: request.controllerClaim,
    operationId: request.operationId,
  });
  if (files.publication?.status !== "confirmed" || !sameReceipt(files.publication, receipt))
    throw new Error("The files publication is not confirmed for this process.");
  // Keep the final authoritative read after every other awaited authorization operation.
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: request.controllerClaim,
  });
  if (
    current.snapshot.lifecycle !== input.lifecycle ||
    current.snapshot.nativeSessionId !== request.nativeSessionId ||
    current.snapshot.generation !== receipt.toGeneration ||
    current.snapshot.facetNonce !== receipt.preparedFacetNonce ||
    current.snapshot.lastPublicationOperationId !== request.operationId ||
    !sameReceipt(current.snapshot.lastPublication, receipt) ||
    !sameReference(current.snapshot.checkpoint, receipt.checkpoint) ||
    !samePublisher(current.currentPublisher, publication.supervisor.currentPublisher)
  )
    throw new Error("The current process authority changed after publication.");
  return current;
}

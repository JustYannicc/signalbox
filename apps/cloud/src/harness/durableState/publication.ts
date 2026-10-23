import type {
  HarnessDurableStatePublicationInput,
  HarnessDurableStatePublicationResult,
} from "../HarnessDurableState.ts";
import type { HarnessFilesPublication, HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";

export interface PublicationStubs {
  readonly runId: string;
  readonly filesStore: { execute(command: unknown): Promise<HarnessFilesStoreResult> };
  readonly threadSupervisor: { execute(command: unknown): Promise<HarnessThreadSupervisorResult> };
}

const failureOf = (error: unknown) => {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return { code: error.code, message: error.message.slice(0, 512) };
  if (error instanceof Error) return { code: "STORAGE", message: error.message.slice(0, 512) };
  return { code: "STORAGE", message: "Publication operation failed." };
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function matchesReceipt(
  receipt: HarnessFilesPublication,
  expected: {
    readonly operationId: string;
    readonly fromGeneration: number;
    readonly toGeneration: number;
    readonly priorFacetNonce: string;
    readonly preparedFacetNonce: string;
    readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
  },
) {
  return (
    receipt.operationId === expected.operationId &&
    receipt.fromGeneration === expected.fromGeneration &&
    receipt.toGeneration === expected.toGeneration &&
    receipt.priorFacetNonce === expected.priorFacetNonce &&
    receipt.preparedFacetNonce === expected.preparedFacetNonce &&
    same(receipt.checkpoint, expected.checkpoint)
  );
}

function publicationMatchesSupervisor(
  supervisor: HarnessThreadSupervisorResult,
  expected: Parameters<typeof matchesReceipt>[1],
) {
  const publication = supervisor.snapshot.lastPublication;
  return (
    publication !== null &&
    publication.operationId === expected.operationId &&
    publication.fromGeneration === expected.fromGeneration &&
    publication.toGeneration === expected.toGeneration &&
    publication.priorFacetNonce === expected.priorFacetNonce &&
    publication.preparedFacetNonce === expected.preparedFacetNonce &&
    same(publication.checkpoint, expected.checkpoint) &&
    supervisor.snapshot.nativeSessionId.length > 0 &&
    supervisor.snapshot.generation === expected.toGeneration &&
    supervisor.snapshot.facetNonce === expected.preparedFacetNonce
  );
}

export async function publishFreshFacet(
  stores: PublicationStubs,
  input: HarnessDurableStatePublicationInput,
): Promise<HarnessDurableStatePublicationResult> {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  const { snapshot } = current;
  if (
    snapshot.nativeSessionId !== input.verifiedNativeSessionId ||
    !same(snapshot.checkpoint, input.checkpoint)
  )
    throw new Error("The prepared facet does not match the durable native session and checkpoint.");

  let expectedGeneration: number;
  let publisher = current.currentPublisher;
  let preparedPublisher = current.preparedPublisher;
  let priorFacetNonce: string;
  if (snapshot.lifecycle === "preparing") {
    if (snapshot.preparedFacet?.operationId !== input.operationId || preparedPublisher === null)
      throw new Error("The current claim has no matching prepared facet.");
    expectedGeneration = snapshot.generation;
    priorFacetNonce = current.currentPublisher.facetNonce;
  } else if (
    (snapshot.lifecycle === "published" ||
      snapshot.lifecycle === "activation-failed" ||
      snapshot.lifecycle === "accepting") &&
    snapshot.lastPublication?.operationId === input.operationId
  ) {
    expectedGeneration = snapshot.lastPublication.fromGeneration;
    priorFacetNonce = snapshot.lastPublication.priorFacetNonce;
    preparedPublisher = current.currentPublisher;
    publisher = current.currentPublisher;
  } else {
    throw new Error("The current supervisor lifecycle cannot publish this facet.");
  }

  const expectedReceipt = {
    operationId: input.operationId,
    fromGeneration: expectedGeneration,
    toGeneration: preparedPublisher.generation,
    priorFacetNonce,
    preparedFacetNonce: preparedPublisher.facetNonce,
    checkpoint: input.checkpoint,
  };
  let files: HarnessFilesStoreResult;
  try {
    files = await stores.filesStore.execute({
      type: "publishFacet",
      runId: stores.runId,
      control: input.control,
      publisher,
      expectedGeneration,
      preparedPublisher,
      operationId: input.operationId,
      checkpoint: input.checkpoint,
    });
  } catch (error) {
    try {
      files = await stores.filesStore.execute({
        type: "readPublication",
        runId: stores.runId,
        control: input.control,
        operationId: input.operationId,
      });
    } catch {
      return {
        status: "files-pending",
        supervisor: current,
        receipt: null,
        failure: failureOf(error),
        activationFailureRecorded: false,
      };
    }
  }
  const receipt = files.publication;
  if (!receipt || !matchesReceipt(receipt, expectedReceipt))
    return {
      status: "files-pending",
      supervisor: current,
      receipt,
      failure: {
        code: "CONFLICT",
        message: "Files publication receipt does not match the prepared facet.",
      },
      activationFailureRecorded: false,
    };

  let supervisor: HarnessThreadSupervisorResult;
  try {
    supervisor = await stores.threadSupervisor.execute({
      type: "publishFreshFacet",
      runId: stores.runId,
      control: input.control,
      publisher,
      expectedGeneration,
      operationId: input.operationId,
      preparedPublisher,
      verifiedNativeSessionId: input.verifiedNativeSessionId,
      checkpoint: input.checkpoint,
    });
  } catch (error) {
    return { status: "supervisor-pending", files, receipt, failure: failureOf(error) };
  }

  if (!publicationMatchesSupervisor(supervisor, expectedReceipt))
    return {
      status: "files-pending",
      supervisor,
      receipt,
      failure: {
        code: "CONFLICT",
        message: "Supervisor publication does not match the files receipt.",
      },
      activationFailureRecorded: false,
    };

  try {
    files = await stores.filesStore.execute({
      type: "confirmFacetPublication",
      runId: stores.runId,
      control: input.control,
      expectedGeneration,
      preparedPublisher,
      operationId: input.operationId,
      checkpoint: input.checkpoint,
    });
    const confirmed = files.publication;
    if (
      !confirmed ||
      confirmed.status !== "confirmed" ||
      !matchesReceipt(confirmed, expectedReceipt)
    )
      throw new Error("Files publication confirmation does not match the supervisor receipt.");
    return { status: "published", supervisor, files, receipt: confirmed };
  } catch (error) {
    let receiptAfterFailure: HarnessFilesPublication | null = null;
    try {
      const observed = await stores.filesStore.execute({
        type: "readPublication",
        runId: stores.runId,
        control: input.control,
        operationId: input.operationId,
      });
      receiptAfterFailure = observed.publication;
      if (
        receiptAfterFailure?.status === "confirmed" &&
        matchesReceipt(receiptAfterFailure, expectedReceipt)
      )
        return { status: "published", supervisor, files: observed, receipt: receiptAfterFailure };
    } catch {
      // A current controller can inspect the supervisor and receipt after this response is lost.
    }
    let activationFailureRecorded = false;
    try {
      await stores.threadSupervisor.execute({
        type: "recordActivationFailure",
        runId: stores.runId,
        control: input.control,
        publisher: supervisor.currentPublisher,
        expectedGeneration: expectedReceipt.toGeneration,
        operationId: input.operationId,
        failure: { kind: "files-publication", message: failureOf(error).message },
      });
      activationFailureRecorded = true;
    } catch {
      // A newer controller reads the persisted publication and repairs it under its own claim.
    }
    return {
      status: "files-pending",
      supervisor,
      receipt: receiptAfterFailure ?? receipt,
      failure: failureOf(error),
      activationFailureRecorded,
    };
  }
}

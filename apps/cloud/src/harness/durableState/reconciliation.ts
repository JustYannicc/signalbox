import type {
  HarnessDurableStateReconcileInput,
  HarnessDurableStateReconcileResult,
} from "./types.ts";
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import type { DurableStateStubs } from "./operations.ts";
import { HarnessDurableStateError, hasCode } from "./errors.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const allJoined = (
  settlement: NonNullable<HarnessDurableStateReconcileInput["invocationSettlement"]>,
) => settlement.invocationRpcJoined && settlement.fetchJoined && settlement.callbackPortsJoined;
const allClean = (
  cleanup: NonNullable<HarnessDurableStateReconcileInput["preparedFacetCleanup"]>,
) =>
  cleanup.stopAcknowledged &&
  cleanup.invocationRpcJoined &&
  cleanup.fetchJoined &&
  cleanup.callbackPortsJoined &&
  cleanup.disposed;

function receiptMatchesPrepared(
  receipt: NonNullable<HarnessFilesStoreResult["publication"]>,
  current: HarnessThreadSupervisorResult,
) {
  const prepared = current.snapshot.preparedFacet;
  return (
    prepared !== null &&
    receipt.operationId === prepared.operationId &&
    receipt.fromGeneration === current.snapshot.generation &&
    receipt.toGeneration === prepared.generation &&
    receipt.priorFacetNonce === current.snapshot.facetNonce &&
    receipt.preparedFacetNonce === prepared.facetNonce &&
    same(receipt.checkpoint, prepared.checkpoint) &&
    current.preparedPublisher?.generation === prepared.generation &&
    current.preparedPublisher.facetNonce === prepared.facetNonce
  );
}

export async function reconcile(
  stores: DurableStateStubs,
  input: HarnessDurableStateReconcileInput,
): Promise<HarnessDurableStateReconcileResult> {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  const prepared = current.snapshot.preparedFacet;
  const alreadyReconciled =
    current.snapshot.reconciliationEvidenceId === input.evidenceId &&
    current.snapshot.reconciliationOutcome === input.outcome;
  const settled = input.invocationSettlement !== null && allJoined(input.invocationSettlement);

  if (
    current.snapshot.generation !== input.expectedGeneration ||
    (current.snapshot.lifecycle !== "indeterminate" &&
      current.snapshot.lifecycle !== "recoverable" &&
      !alreadyReconciled)
  )
    throw new HarnessDurableStateError({ code: "OUT_OF_ORDER" });
  if (input.outcome !== "unknown" && !settled)
    throw new HarnessDurableStateError({ code: "INDETERMINATE" });
  if ((input.outcome === "completed") !== (input.checkpoint !== null))
    throw new HarnessDurableStateError({ code: "INVALID" });
  if (prepared !== null && (!input.preparedFacetCleanup || !allClean(input.preparedFacetCleanup)))
    throw new HarnessDurableStateError({ code: "INDETERMINATE" });
  if (prepared === null && input.preparedFacetCleanup !== null && !alreadyReconciled)
    throw new HarnessDurableStateError({ code: "CONFLICT" });

  let files: HarnessFilesStoreResult | null = null;
  if (prepared !== null) {
    let receipt: HarnessFilesStoreResult | null = null;
    try {
      receipt = await stores.filesStore.execute({
        type: "readPublication",
        runId: stores.runId,
        control: input.control,
        operationId: prepared.operationId,
      });
    } catch (error) {
      if (!hasCode(error, "MISSING")) throw error;
    }

    if (receipt?.publication) {
      if (!receiptMatchesPrepared(receipt.publication, current))
        throw new HarnessDurableStateError({ code: "CONFLICT" });
      if (receipt.publication.status === "confirmed")
        throw new HarnessDurableStateError({ code: "CONFLICT" });
      const preparedPublisher = current.preparedPublisher;
      if (!preparedPublisher) throw new HarnessDurableStateError({ code: "CONFLICT" });
      files = await stores.filesStore.execute({
        type: "abortFacetPublication",
        runId: stores.runId,
        control: input.control,
        expectedGeneration: receipt.publication.fromGeneration,
        preparedPublisher,
        operationId: prepared.operationId,
      });
    }
  }

  const supervisor = await stores.threadSupervisor.execute({
    type: "reconcile",
    runId: stores.runId,
    control: input.control,
    expectedGeneration: input.expectedGeneration,
    evidenceId: input.evidenceId,
    outcome: input.outcome,
    checkpoint: input.checkpoint,
    invocationSettlement: input.invocationSettlement,
    preparedFacetCleanup: input.preparedFacetCleanup,
  });
  return { supervisor, files };
}

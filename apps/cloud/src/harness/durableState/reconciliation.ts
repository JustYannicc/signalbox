import type {
  HarnessDurableStateReconcileInput,
  HarnessDurableStateReconcileResult,
  HarnessDurableStateStubs,
} from "./types.ts";
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import { HarnessDurableStateError, hasCode } from "./errors.ts";
import { sourceFromSnapshot } from "./supervisor/reconciliationReceipts.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

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
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateReconcileInput,
): Promise<HarnessDurableStateReconcileResult> {
  const observed = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  const expectedSource = sourceFromSnapshot(observed.snapshot);
  const inspection = await stores.threadSupervisor.reserveReconciliation({
    runId: stores.runId,
    ...input,
    expectedSource,
    reserve: false,
  });
  if (inspection.status === "committed") return { supervisor: inspection.supervisor, files: null };
  const legacyBinding = inspection.status === "pending" ? inspection.admissionBinding : null;

  if (input.outcome === "completed" && input.checkpoint) {
    let files: HarnessFilesStoreResult;
    try {
      files = await stores.filesStore.execute({
        type: "readCheckpoint",
        runId: stores.runId,
        publisher: observed.currentPublisher,
        checkpointId: input.checkpoint.checkpointId,
      });
    } catch (error) {
      if (hasCode(error, "MISSING")) throw new HarnessDurableStateError({ code: "CONFLICT" });
      throw error;
    }
    const checkpointMatches =
      same(files.checkpoint, input.checkpoint) &&
      (observed.snapshot.admittedStepId === null
        ? same(input.checkpoint, observed.snapshot.checkpoint)
        : files.parentCheckpointId === observed.snapshot.checkpoint.checkpointId);
    if (!checkpointMatches) throw new HarnessDurableStateError({ code: "CONFLICT" });
  }

  if (input.outcome !== "unknown") {
    await stores.filesStore.execute({
      type: "reconcileAdmission",
      validateOnly: true,
      legacyBinding,
      runId: stores.runId,
      control: input.control,
      publisher: observed.currentPublisher,
      expectedGeneration: observed.snapshot.generation,
      evidenceId: input.evidenceId,
      stepId: observed.snapshot.admittedStepId,
      outcome: input.outcome,
      expectedCheckpoint: observed.snapshot.checkpoint,
      checkpoint: input.checkpoint,
    });
  }

  const preparedBeforeReservation = observed.snapshot.preparedFacet;
  if (preparedBeforeReservation !== null && input.outcome !== "unknown") {
    let receipt: HarnessFilesStoreResult | null = null;
    try {
      receipt = await stores.filesStore.execute({
        type: "readPublication",
        runId: stores.runId,
        control: input.control,
        operationId: preparedBeforeReservation.operationId,
      });
    } catch (error) {
      if (!hasCode(error, "MISSING")) throw error;
    }
    if (receipt?.publication) {
      if (!receiptMatchesPrepared(receipt.publication, observed))
        throw new HarnessDurableStateError({ code: "CONFLICT" });
      if (receipt.publication.status === "confirmed")
        throw new HarnessDurableStateError({ code: "CONFLICT" });
    }
  }

  const reservation = await stores.threadSupervisor.reserveReconciliation({
    runId: stores.runId,
    ...input,
    expectedSource,
    reserve: true,
  });
  const current = reservation.supervisor;
  if (reservation.status === "committed") return { supervisor: current, files: null };
  const reservedLegacyBinding =
    legacyBinding !== null &&
    reservation.status === "pending" &&
    same(legacyBinding, reservation.admissionBinding)
      ? reservation.admissionBinding
      : null;

  const prepared = current.snapshot.preparedFacet;

  let files: HarnessFilesStoreResult | null = null;
  if (prepared !== null && input.outcome !== "unknown") {
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

  let admissionResolution: HarnessFilesStoreResult["admissionResolution"] = null;
  if (input.outcome !== "unknown") {
    const admission = await stores.filesStore.execute({
      type: "reconcileAdmission",
      legacyBinding: reservedLegacyBinding,
      runId: stores.runId,
      control: input.control,
      publisher: current.currentPublisher,
      expectedGeneration: current.snapshot.generation,
      evidenceId: input.evidenceId,
      stepId: current.snapshot.admittedStepId,
      outcome: input.outcome,
      expectedCheckpoint: current.snapshot.checkpoint,
      checkpoint: input.checkpoint,
    });
    files = admission;
    admissionResolution = admission.admissionResolution;
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
    admissionResolution,
  });
  return {
    supervisor,
    files: supervisor.snapshot.reconciliationEvidenceId === input.evidenceId ? files : null,
  };
}

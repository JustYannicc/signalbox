import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness } from "./tests/harnessStateWorkerd.testSupport.ts";

const legacyReconciliationRunId = "workerd-reconciliation-legacy-r4";
const overlappingReconciliationRunId = "workerd-reconciliation-overlap-r4";

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("keeps older reconciliation retries from touching newer prepared work after DO rehydration", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-history-prepare");
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toEqual({ prepared: "C", checkpoint: "workerd-checkpoint-1" });

  const runId = "workerd-reconciliation-history-proof";
  const storage = await main.getDurableObjectStorage("HarnessThreadSupervisorObject", {
    name: runId,
  });
  for (const evidenceId of ["history-evidence-e", "history-evidence-f"]) {
    const receipts = await storage.exec(
      "SELECT receipt_json FROM harness_thread_supervisor_reconciliation WHERE evidence_id = ?",
      evidenceId,
    );
    const receiptJson = receipts[0]?.receipt_json;
    expect(typeof receiptJson).toBe("string");
    if (typeof receiptJson !== "string") throw new Error("Format-2 receipt is missing.");
    const receipt = JSON.parse(receiptJson) as Record<string, unknown>;
    expect(receipt.legacy).toBe(false);
    delete receipt.legacy;
    await storage.exec(
      "UPDATE harness_thread_supervisor_reconciliation SET receipt_json = ? WHERE evidence_id = ?",
      JSON.stringify(receipt),
      evidenceId,
    );
  }
  await main.evictDurableObject("HarnessFilesStoreObject", { name: runId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: runId });
  const replay = await main.fetch("http://proof/reconciliation-history-replay");
  expect(replay.status).toBe(200);
  const result = (await replay.json()) as { before: unknown; after: unknown } & Record<
    string,
    unknown
  >;
  expect(result).toMatchObject({
    replayEAction: "unchanged",
    replayFAction: "unchanged",
    changedECode: "CONFLICT",
    changedFCode: "CONFLICT",
    blockedReplacementCode: "INDETERMINATE",
    before: {
      preparedFacet: {
        operationId: "history-prepared-c",
        generation: 2,
        facetNonce: "workerd-history-facet-2c",
      },
      lifecycle: "indeterminate",
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      admittedStepId: null,
      admissionResolution: {
        evidenceId: "history-evidence-f",
        stepId: null,
        outcome: "notApplied",
      },
      activeStepId: null,
      publication: {
        operationId: "history-prepared-c",
        status: "pending",
      },
    },
    cSpecificReconcile: "reconciled",
    replacementAfterC: "prepared",
    receiptGoneAfterC: true,
  });
  expect(result.after).toEqual(result.before);
});

it("seeds a committed format-1 replay before newer work replaces its latest marker", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-legacy-r4-prepare");
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toMatchObject({
    action: "reconciled",
    evidenceId: "legacy-r4-evidence-e",
    admissionResolution: { evidenceId: "legacy-r4-evidence-e", outcome: "notApplied" },
  });

  const storage = await main.getDurableObjectStorage("HarnessThreadSupervisorObject", {
    name: legacyReconciliationRunId,
  });
  const stateRows = await storage.exec(
    "SELECT state_json FROM harness_thread_supervisor_state WHERE slot = 1",
  );
  const stateJson = stateRows[0]?.state_json;
  expect(typeof stateJson).toBe("string");
  if (typeof stateJson !== "string") throw new Error("Format-1 Supervisor state is missing.");
  const legacyState = JSON.parse(stateJson) as Record<string, unknown>;
  expect(legacyState.reconciliationEvidenceId).toBe("legacy-r4-evidence-e");
  expect(legacyState.reconciliationAdmissionResolution).not.toBeNull();

  await storage.exec("DROP INDEX IF EXISTS harness_thread_supervisor_reconciliation_one_pending");
  await storage.exec("DROP TABLE harness_thread_supervisor_reconciliation");
  await storage.exec("UPDATE harness_thread_supervisor_format SET version = 1 WHERE slot = 1");
  await main.evictDurableObject("HarnessThreadSupervisorObject", {
    name: legacyReconciliationRunId,
  });

  const continued = await main.fetch("http://proof/reconciliation-legacy-r4-continue");
  expect(continued.status).toBe(200);
  expect(await continued.json()).toMatchObject({
    replayFAction: "reconciled",
    latestEvidenceId: "legacy-r4-evidence-f",
    lifecycle: "indeterminate",
    preparedFacet: { operationId: "legacy-r4-prepared-c", generation: 2 },
  });

  const migratedRows = await storage.exec(
    "SELECT version FROM harness_thread_supervisor_format WHERE slot = 1",
  );
  expect(migratedRows[0]?.version).toBe(2);
  const receiptRows = await storage.exec(
    "SELECT status, receipt_json FROM harness_thread_supervisor_reconciliation WHERE evidence_id = ?",
    "legacy-r4-evidence-e",
  );
  const receiptRow = receiptRows[0];
  expect(receiptRow?.status).toBe("committed");
  expect(typeof receiptRow?.receipt_json).toBe("string");
  if (typeof receiptRow?.receipt_json !== "string")
    throw new Error("Migrated legacy receipt is missing.");
  const legacyReceipt = JSON.parse(receiptRow.receipt_json) as Record<string, unknown>;
  expect(legacyReceipt).toMatchObject({
    version: 1,
    request: {
      evidenceId: "legacy-r4-evidence-e",
      expectedGeneration: 1,
      outcome: "notApplied",
      checkpoint: null,
      invocationSettlement: {
        invocationRpcJoined: true,
        fetchJoined: true,
        callbackPortsJoined: true,
      },
      preparedFacetCleanup: {
        stopAcknowledged: true,
        invocationRpcJoined: true,
        fetchJoined: true,
        callbackPortsJoined: true,
        disposed: true,
      },
    },
    source: null,
    status: "committed",
    legacy: true,
    admissionResolution: legacyState.reconciliationAdmissionResolution,
  });
  expect(legacyReceipt.authority).toEqual({
    ownerId: "workerd-owner",
    incarnationId: "workerd-controller-incarnation-2",
    epoch: 2,
  });

  await main.evictDurableObject("HarnessFilesStoreObject", { name: legacyReconciliationRunId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", {
    name: legacyReconciliationRunId,
  });
  const replay = await main.fetch("http://proof/reconciliation-legacy-r4-replay");
  expect(replay.status).toBe(200);
  const result = (await replay.json()) as Record<string, unknown>;
  expect(result).toMatchObject({
    replayEAction: "unchanged",
    replayEFiles: null,
    alteredECode: "CONFLICT",
    replayFAction: "unchanged",
    replayFFiles: null,
    blockedReplacementCode: "INDETERMINATE",
    before: {
      supervisor: {
        lifecycle: "indeterminate",
        reconciliationEvidenceId: "legacy-r4-evidence-f",
        preparedFacet: { operationId: "legacy-r4-prepared-c", generation: 2 },
      },
      files: {
        admissionResolution: { evidenceId: "legacy-r4-evidence-f", outcome: "notApplied" },
        publication: { operationId: "legacy-r4-prepared-c", status: "pending" },
      },
    },
    cSpecificReconcile: "reconciled",
    replacementAfterC: "prepared",
    receiptGoneAfterC: true,
  });
  expect(result.after).toEqual(result.before);
});

it("does not let a delayed identical retry replace newer Files evidence after eviction", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-overlap-r4-prepare");
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toMatchObject({ prepared: "A" });
  const filesStorage = await main.getDurableObjectStorage("HarnessFilesStoreObject", {
    name: overlappingReconciliationRunId,
  });
  await filesStorage.exec("DROP TABLE harness_files_admission_receipt");
  await main.evictDurableObject("HarnessFilesStoreObject", {
    name: overlappingReconciliationRunId,
  });

  const overlap = await main.fetch("http://proof/reconciliation-overlap-r4-run");
  expect(overlap.status).toBe(200);
  const result = (await overlap.json()) as Record<string, unknown>;
  expect(result).toMatchObject({
    reservationStatus: "pending",
    otherEAction: "reconciled",
    otherEFilesAction: "reconciled",
    newer: {
      replayFAction: "reconciled",
      latestEvidenceId: "overlap-r4-evidence-f",
      lifecycle: "recoverable",
      preparedFacet: null,
    },
    delayed: {
      error: null,
      result: {
        files: null,
        supervisor: {
          action: "unchanged",
          snapshot: {
            lifecycle: "indeterminate",
            reconciliationEvidenceId: "overlap-r4-evidence-f",
            preparedFacet: { operationId: "overlap-r4-prepared-c", generation: 2 },
          },
        },
      },
    },
    alteredECode: "CONFLICT",
    before: {
      supervisor: {
        lifecycle: "indeterminate",
        reconciliationEvidenceId: "overlap-r4-evidence-f",
        preparedFacet: { operationId: "overlap-r4-prepared-c", generation: 2 },
      },
      files: {
        admissionResolution: { evidenceId: "overlap-r4-evidence-f", outcome: "notApplied" },
        publication: { operationId: "overlap-r4-prepared-c", status: "pending" },
      },
    },
  });
  expect(result.after).toEqual(result.before);
  expect(result.afterAltered).toEqual(result.before);
  expect(
    await filesStorage.exec(
      "SELECT name FROM sqlite_master WHERE name = 'harness_files_admission_receipt'",
    ),
  ).toHaveLength(1);

  await main.evictDurableObject("HarnessFilesStoreObject", {
    name: overlappingReconciliationRunId,
  });
  await main.evictDurableObject("HarnessThreadSupervisorObject", {
    name: overlappingReconciliationRunId,
  });
  const filesReplay = await main.fetch("http://proof/reconciliation-overlap-r4-files-replay");
  expect(filesReplay.status).toBe(200);
  expect(await filesReplay.json()).toMatchObject({
    action: "unchanged",
    admissionResolution: { evidenceId: "overlap-r4-evidence-e", outcome: "notApplied" },
  });
  const afterEvictionReplay = await main.fetch("http://proof/reconciliation-overlap-r4-snapshot");
  expect(await afterEvictionReplay.json()).toEqual(result.before);
});

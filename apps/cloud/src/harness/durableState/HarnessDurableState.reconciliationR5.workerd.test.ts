import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness } from "./harnessStateWorkerd.testSupport.ts";
import {
  completedR5EvidenceId,
  completedR5RunId,
} from "./harnessStateWorkerd.reconciliationCompletedR5.ts";

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("rehydrates and completes the same completed-step reservation after the Files reply is lost", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-completed-r5-prepare");
  expect(prepared.status).toBe(200);
  const started = (await prepared.json()) as Record<string, unknown>;
  expect(started).toMatchObject({
    lostReplyCode: "STORAGE",
    parentCheckpointId: "workerd-checkpoint-1",
    before: {
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      admittedStepId: "completed-r5-step-s",
      lifecycle: "indeterminate",
    },
    after: {
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      admittedStepId: "completed-r5-step-s",
      lifecycle: "indeterminate",
      reconciliationEvidenceId: null,
    },
    filesResolution: {
      evidenceId: completedR5EvidenceId,
      stepId: "completed-r5-step-s",
      outcome: "completed",
      expectedCheckpoint: { checkpointId: "workerd-checkpoint-1" },
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
    },
  });

  const supervisorStorage = await main.getDurableObjectStorage("HarnessThreadSupervisorObject", {
    name: completedR5RunId,
  });
  const pendingRows = await supervisorStorage.exec(
    "SELECT status, receipt_json FROM harness_thread_supervisor_reconciliation WHERE evidence_id = ?",
    completedR5EvidenceId,
  );
  expect(pendingRows[0]?.status).toBe("pending");
  expect(typeof pendingRows[0]?.receipt_json).toBe("string");
  if (typeof pendingRows[0]?.receipt_json !== "string")
    throw new Error("Pending Supervisor receipt is missing.");
  const pendingReceipt = JSON.parse(pendingRows[0].receipt_json) as Record<string, unknown>;
  expect(pendingReceipt).toMatchObject({
    request: {
      evidenceId: completedR5EvidenceId,
      expectedGeneration: 1,
      outcome: "completed",
    },
    status: "pending",
  });

  const filesStorage = await main.getDurableObjectStorage("HarnessFilesStoreObject", {
    name: completedR5RunId,
  });
  const fileReceiptRows = await filesStorage.exec(
    "SELECT receipt_json FROM harness_files_admission_receipt WHERE evidence_id = ?",
    completedR5EvidenceId,
  );
  expect(typeof fileReceiptRows[0]?.receipt_json).toBe("string");
  if (typeof fileReceiptRows[0]?.receipt_json !== "string")
    throw new Error("Committed Files receipt is missing.");
  const filesReceipt = JSON.parse(fileReceiptRows[0].receipt_json) as Record<string, unknown>;
  expect(filesReceipt).toMatchObject({
    request: {
      evidenceId: completedR5EvidenceId,
      stepId: "completed-r5-step-s",
      expectedCheckpoint: { checkpointId: "workerd-checkpoint-1" },
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
    },
    source: {
      activeStepId: null,
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
      lastCommittedStepId: "completed-r5-step-s",
      lastCommittedFromCheckpoint: { checkpointId: "workerd-checkpoint-1" },
    },
  });
  expect(
    await filesStorage.exec(
      "SELECT checkpoint_id FROM harness_files_checkpoint WHERE checkpoint_id = ?",
      "workerd-completed-r5-q",
    ),
  ).toHaveLength(1);

  await main.evictDurableObject("HarnessRunStoreObject", { name: completedR5RunId });
  await main.evictDurableObject("HarnessFilesStoreObject", { name: completedR5RunId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: completedR5RunId });
  const replayResponse = await main.fetch("http://proof/reconciliation-completed-r5-replay");
  expect(replayResponse.status).toBe(200);
  const replay = (await replayResponse.json()) as Record<string, unknown>;
  expect(replay).toMatchObject({
    replayAction: "reconciled",
    replaySupervisor: {
      lifecycle: "recoverable",
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
      admittedStepId: null,
      preparedFacet: null,
      reconciliationEvidenceId: completedR5EvidenceId,
      reconciliationAdmissionResolution: {
        evidenceId: completedR5EvidenceId,
        stepId: "completed-r5-step-s",
        outcome: "completed",
      },
    },
    replayFilesResolution: { evidenceId: completedR5EvidenceId, outcome: "completed" },
    changedCode: "CONFLICT",
    wrongControlCode: "STALE_CONTROL",
    laterEvidenceId: "completed-r5-evidence-f",
    beforeHistoricalReplay: { evidenceId: "completed-r5-evidence-f", outcome: "notApplied" },
    historicalReplayAction: "unchanged",
    historicalReplayResult: { evidenceId: completedR5EvidenceId, outcome: "completed" },
    wrongPublisherCode: "STALE_PUBLISHER",
    afterHistoricalReplay: { evidenceId: "completed-r5-evidence-f", outcome: "notApplied" },
  });
  expect(replay.changedAfter).toEqual(replay.changedBefore);
  expect(replay.changedFilesAfter).toEqual(replay.changedFilesBefore);

  const committedRows = await supervisorStorage.exec(
    "SELECT status, receipt_json FROM harness_thread_supervisor_reconciliation WHERE evidence_id = ?",
    completedR5EvidenceId,
  );
  expect(committedRows[0]?.status).toBe("committed");
  const committedReceipt = JSON.parse(committedRows[0]?.receipt_json as string) as Record<
    string,
    unknown
  >;
  expect(committedReceipt.request).toEqual(pendingReceipt.request);
  expect(committedReceipt.source).toEqual(pendingReceipt.source);
  expect(
    await filesStorage.exec(
      "SELECT checkpoint_id FROM harness_files_checkpoint WHERE checkpoint_id = ?",
      "workerd-completed-r5-q",
    ),
  ).toHaveLength(1);
});

it("backfills a completed legacy receipt from its pending Supervisor binding", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-completed-r5-prepare");
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toMatchObject({
    lostReplyCode: "STORAGE",
    filesResolution: {
      evidenceId: completedR5EvidenceId,
      stepId: "completed-r5-step-s",
      outcome: "completed",
      expectedCheckpoint: { checkpointId: "workerd-checkpoint-1" },
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
    },
  });

  const filesStorage = await main.getDurableObjectStorage("HarnessFilesStoreObject", {
    name: completedR5RunId,
  });
  const pendingRows = await main
    .getDurableObjectStorage("HarnessThreadSupervisorObject", { name: completedR5RunId })
    .then((storage) =>
      storage.exec(
        "SELECT status FROM harness_thread_supervisor_reconciliation WHERE evidence_id = ?",
        completedR5EvidenceId,
      ),
    );
  expect(pendingRows[0]?.status).toBe("pending");

  // A legacy Files database has the committed resolution but no per-evidence receipt table.
  await filesStorage.exec("DROP TABLE harness_files_admission_receipt");
  await main.evictDurableObject("HarnessRunStoreObject", { name: completedR5RunId });
  await main.evictDurableObject("HarnessFilesStoreObject", { name: completedR5RunId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: completedR5RunId });

  const replayResponse = await main.fetch("http://proof/reconciliation-completed-r5-replay");
  expect(replayResponse.status).toBe(200);
  expect(await replayResponse.json()).toMatchObject({
    replayAction: "reconciled",
    replaySupervisor: {
      reconciliationEvidenceId: completedR5EvidenceId,
      reconciliationAdmissionResolution: {
        evidenceId: completedR5EvidenceId,
        stepId: "completed-r5-step-s",
        outcome: "completed",
      },
    },
    changedCode: "CONFLICT",
    wrongControlCode: "STALE_CONTROL",
    wrongPublisherCode: "STALE_PUBLISHER",
    laterEvidenceId: "completed-r5-evidence-f",
    beforeHistoricalReplay: { evidenceId: "completed-r5-evidence-f" },
    afterHistoricalReplay: { evidenceId: "completed-r5-evidence-f" },
  });

  const receiptRows = await filesStorage.exec(
    "SELECT receipt_json FROM harness_files_admission_receipt WHERE evidence_id = ?",
    completedR5EvidenceId,
  );
  expect(typeof receiptRows[0]?.receipt_json).toBe("string");
  if (typeof receiptRows[0]?.receipt_json !== "string")
    throw new Error("Completed legacy Files receipt was not backfilled.");
  expect(JSON.parse(receiptRows[0].receipt_json)).toMatchObject({
    request: {
      evidenceId: completedR5EvidenceId,
      stepId: "completed-r5-step-s",
      expectedCheckpoint: { checkpointId: "workerd-checkpoint-1" },
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
    },
    source: {
      kind: "legacyResolution",
      checkpoint: { checkpointId: "workerd-completed-r5-q" },
      lastCommittedStepId: "completed-r5-step-s",
      lastCommittedFromCheckpoint: { checkpointId: "workerd-checkpoint-1" },
      legacyBinding: {
        evidenceId: completedR5EvidenceId,
        source: {
          checkpoint: { checkpointId: "workerd-checkpoint-1" },
          admittedStepId: "completed-r5-step-s",
        },
      },
      legacyResolution: { evidenceId: completedR5EvidenceId, outcome: "completed" },
    },
  });
});

it("decodes the completed null-step receipt branch", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/reconciliation-completed-null-r5");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    lifecycle: "recoverable",
    replayAction: "unchanged",
    replayResolution: {
      evidenceId: "completed-r5-null-evidence",
      stepId: null,
      outcome: "completed",
    },
  });
});

import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness } from "./harnessStateWorkerd.testSupport.ts";
import {
  legacyR5EvidenceId,
  legacyR5UnboundEvidenceId,
} from "./harnessStateWorkerd.reconciliationLegacyR5.ts";

let harness: ReturnType<typeof makeHarness>;
type HarnessWorker = ReturnType<ReturnType<typeof makeHarness>["getWorker"]>;
type HarnessStorage = Awaited<ReturnType<HarnessWorker["getDurableObjectStorage"]>>;

beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

function parseState(row: Record<string, unknown> | undefined) {
  const stateJson = row?.state_json;
  expect(typeof stateJson).toBe("string");
  if (typeof stateJson !== "string") throw new Error("Files state row is missing.");
  return { stateJson, state: JSON.parse(stateJson) as Record<string, unknown> };
}

async function seedLegacyAdmissionResolution(storage: HarnessStorage, evidenceId: string) {
  const rows = await storage.exec("SELECT state_json FROM harness_files_meta WHERE slot = 1");
  const { state } = parseState(rows[0]);
  const checkpoint = state.checkpoint as { checkpointId: string; manifestSha256: string };
  state.admissionResolution = {
    evidenceId,
    stepId: null,
    outcome: "notApplied",
    expectedCheckpoint: checkpoint,
    checkpoint,
  };
  const stateJson = JSON.stringify(state);
  await storage.exec("UPDATE harness_files_meta SET state_json = ? WHERE slot = 1", stateJson);
  await storage.exec("DROP TABLE harness_files_admission_receipt");
  return stateJson;
}

it("imports a legacy Files resolution only under its existing pending Supervisor binding", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-legacy-r5-prepare-files");
  expect(prepared.status).toBe(200);
  const { runId } = (await prepared.json()) as { runId: string };
  const filesStorage = await main.getDurableObjectStorage("HarnessFilesStoreObject", {
    name: runId,
  });
  const legacyStateJson = await seedLegacyAdmissionResolution(filesStorage, legacyR5EvidenceId);
  await main.evictDurableObject("HarnessFilesStoreObject", { name: runId });

  const reserved = await main.fetch("http://proof/reconciliation-legacy-r5-reserve-supervisor");
  expect(reserved.status).toBe(200);
  expect(await reserved.json()).toMatchObject({ status: "pending" });
  const overlapResponse = await main.fetch("http://proof/reconciliation-legacy-r5-run");
  expect(overlapResponse.status).toBe(200);
  const overlap = (await overlapResponse.json()) as Record<string, unknown>;
  expect(overlap).toMatchObject({
    reservationStatus: "pending",
    otherEAction: "reconciled",
    otherEFilesAction: "unchanged",
    later: { evidenceId: "overlap-r4-evidence-f", lifecycle: "recoverable", preparedFacet: null },
    delayed: { error: null, filesAction: "unchanged", supervisorAction: "unchanged" },
    alteredECode: "CONFLICT",
  });
  expect(overlap.after).toEqual(overlap.before);
  expect(overlap.afterAltered).toEqual(overlap.before);

  const stateRows = await filesStorage.exec(
    "SELECT state_json FROM harness_files_meta WHERE slot = 1",
  );
  const stateAfterOverlap = parseState(stateRows[0]);
  expect(stateAfterOverlap.state.admissionResolution).toMatchObject({
    evidenceId: "overlap-r4-evidence-f",
    outcome: "notApplied",
  });
  expect(stateAfterOverlap.stateJson).not.toBe(legacyStateJson);
  const receiptRows = await filesStorage.exec(
    "SELECT receipt_json FROM harness_files_admission_receipt WHERE evidence_id = ?",
    legacyR5EvidenceId,
  );
  expect(typeof receiptRows[0]?.receipt_json).toBe("string");
  if (typeof receiptRows[0]?.receipt_json !== "string")
    throw new Error("Migrated legacy admission receipt is missing.");
  expect(JSON.parse(receiptRows[0].receipt_json)).toMatchObject({
    request: { evidenceId: legacyR5EvidenceId, outcome: "notApplied", stepId: null },
    source: {
      kind: "legacyResolution",
      legacyResolution: { evidenceId: legacyR5EvidenceId, outcome: "notApplied" },
      legacyBinding: {
        evidenceId: legacyR5EvidenceId,
        source: { checkpoint: { checkpointId: "workerd-checkpoint-1" }, admittedStepId: null },
      },
    },
  });

  await main.evictDurableObject("HarnessRunStoreObject", { name: runId });
  await main.evictDurableObject("HarnessFilesStoreObject", { name: runId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: runId });
  const replay = await main.fetch("http://proof/reconciliation-legacy-r5-replay");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    supervisorAction: "unchanged",
    supervisorFiles: null,
    exactFilesAction: "unchanged",
    exactFilesResolution: { evidenceId: legacyR5EvidenceId, outcome: "notApplied" },
    alteredFilesCode: "CONFLICT",
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
    afterReplay: {
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
    blockedReplacementCode: "INDETERMINATE",
    cSpecificReconcile: "reconciled",
    replacementAction: "prepared",
  });
});

it("fails closed when a legacy resolution has no authenticated pending binding", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-unbound-legacy-r5-prepare");
  expect(prepared.status).toBe(200);
  const { runId } = (await prepared.json()) as { runId: string };
  const filesStorage = await main.getDurableObjectStorage("HarnessFilesStoreObject", {
    name: runId,
  });
  const originalStateJson = await seedLegacyAdmissionResolution(
    filesStorage,
    legacyR5UnboundEvidenceId,
  );
  await main.evictDurableObject("HarnessFilesStoreObject", { name: runId });
  const attempted = await main.fetch("http://proof/reconciliation-unbound-legacy-r5-attempt");
  expect(attempted.status).toBe(200);
  expect(await attempted.json()).toMatchObject({
    code: "CONFLICT",
    supervisorEvidenceId: null,
    lifecycle: "indeterminate",
    admissionResolution: { evidenceId: legacyR5UnboundEvidenceId, outcome: "notApplied" },
  });
  const stateRows = await filesStorage.exec(
    "SELECT state_json FROM harness_files_meta WHERE slot = 1",
  );
  expect(stateRows[0]?.state_json).toBe(originalStateJson);
  expect(
    await filesStorage.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_files_admission_receipt'",
    ),
  ).toHaveLength(0);
  const supervisorStorage = await main.getDurableObjectStorage("HarnessThreadSupervisorObject", {
    name: runId,
  });
  expect(
    await supervisorStorage.exec(
      "SELECT evidence_id FROM harness_thread_supervisor_reconciliation WHERE status = 'pending'",
    ),
  ).toHaveLength(0);
});

import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness } from "./tests/harnessStateWorkerd.testSupport.ts";

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("resolves an admitted Files step before publishing a replacement facet", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/reconcile-admission");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    admission: "admitted",
    drain: "draining",
    lostFilesReplyCode: "STORAGE",
    persistedAfterLostReply: {
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      activeStepId: null,
      resolution: {
        evidenceId: "admission-recovery-evidence",
        stepId: "admitted-before-reconcile",
        outcome: "notApplied",
      },
    },
    retryAction: "reconciled",
    persistedAfterRetry: {
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      activeStepId: null,
      resolution: { evidenceId: "admission-recovery-evidence" },
    },
    publication: "published",
    activation: "accepting",
    stalePublisherCommitCode: "STALE_PUBLISHER",
  });
});

it("accepts completed reconciliation only for the checkpoint committed in Files", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/reconcile-completed");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    partialCommitStatus: "supervisor-pending",
    wrongOutcomeCode: "CONFLICT",
    wrongCheckpointCode: "CONFLICT",
    filesAfterMismatch: {
      checkpoint: { checkpointId: "workerd-completed-checkpoint-2" },
      admissionResolution: null,
    },
    reconciledLifecycle: "recoverable",
    reconciledCheckpoint: { checkpointId: "workerd-completed-checkpoint-2" },
    filesAdmissionResolution: {
      evidenceId: "completed-checkpoint-evidence",
      stepId: "completed-before-supervisor-reconcile",
      outcome: "completed",
      checkpoint: { checkpointId: "workerd-completed-checkpoint-2" },
    },
  });
});

it("repairs pending control synchronization before another takeover", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/control-recovery");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    firstStatus: "files-pending",
    firstFailureCode: "STORAGE",
    pendingSync: {
      operationId: "control-sync-1",
      fromEpoch: 1,
      toEpoch: 2,
      expectedGeneration: 1,
    },
    filesBeforeRepairCode: "STALE_CONTROL",
    staleKeyCode: "STALE_CONTROL",
    skippedEpochCode: "CONFLICT",
    filesAfterRepairCode: "MISSING",
    secondTakeoverStatus: "draining",
    finalControlEpoch: 3,
    finalPendingSync: null,
    filesAtThirdEpochCode: "MISSING",
  });
});

it("rejects a mismatched Files sync operation and repairs the recorded one", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/control-sync-operation");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    firstStatus: "files-pending",
    wrongOperationCode: "CONFLICT",
    repairedStatus: "draining",
    finalFilesLookupCode: "MISSING",
  });
});

it("reads the exact selected publication receipt while a later one is pending", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/publication-receipts");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    firstStatus: "published",
    confirmedA: { operationId: "publication-a", status: "confirmed" },
    pendingB: { operationId: "publication-b", status: "pending" },
    missingCode: "MISSING",
    staleClaimCode: "STALE_CONTROL",
  });
});

it("short-circuits exact reconciliation retries before touching newer pending work", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/reconcile-replay");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    lostSupervisorReplyCode: "STORAGE",
    persistedEvidence: "reconcile-replay-evidence",
    replayAction: "unchanged",
    changedSettlementCode: "CONFLICT",
    changedCheckpointCode: "CONFLICT",
    changedCleanupCode: "CONFLICT",
    pendingReceipt: { operationId: "prepared-after-reconcile", status: "pending" },
    preparedFacet: {
      operationId: "prepared-after-reconcile",
      generation: 2,
      facetNonce: "workerd-facet-nonce-2",
    },
    lifecycle: "preparing",
  });
});

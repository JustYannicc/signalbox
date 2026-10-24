import {
  clean,
  control1,
  control2,
  durableFor,
  failed,
  initialize,
  joins,
  publisher1,
  publisher2,
  incomplete,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";

export const legacyReconciliationRunId = "workerd-reconciliation-legacy-r4";

const publisher2b = {
  generation: 2,
  facetNonce: "workerd-legacy-r4-facet-2b",
  publisherKey: "workerd-legacy-r4-publisher-2b-key",
};
const publisher2c = {
  generation: 2,
  facetNonce: "workerd-legacy-r4-facet-2c",
  publisherKey: "workerd-legacy-r4-publisher-2c-key",
};
const publisher2d = {
  generation: 2,
  facetNonce: "workerd-legacy-r4-facet-2d",
  publisherKey: "workerd-legacy-r4-publisher-2d-key",
};

function reconciliationInput(evidenceId: string, preparedFacetCleanup = clean) {
  return {
    control: control2,
    expectedGeneration: 1,
    evidenceId,
    outcome: "notApplied" as const,
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup,
  };
}

async function prepareFailedPublication(
  env: WorkerdEnv,
  runId: string,
  checkpoint: Awaited<ReturnType<typeof initialize>>["files"]["checkpoint"],
  operationId: string,
  preparedPublisher: HarnessThreadSupervisorPublisher,
) {
  const durable = durableFor(env, runId);
  await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId,
    preparedPublisher,
  });
  await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "publishFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher,
    operationId,
    checkpoint,
  });
  await durable.recordPreparedFacetFailure({
    control: control2,
    operationId,
    phase: "publish",
    failure: { kind: "unknown", message: "facet publication outcome was interrupted" },
    cleanup: incomplete,
  });
}

export async function prepareLegacyReconciliation(env: WorkerdEnv) {
  const runId = legacyReconciliationRunId;
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "legacy-r4-initial-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    requestId: "legacy-r4-stop-request",
    acknowledgementId: "legacy-r4-stop-acknowledgement",
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "stopped",
    ...joins,
  });
  await prepareFailedPublication(
    env,
    runId,
    initialized.files.checkpoint,
    "legacy-r4-prepared-a",
    publisher2,
  );
  const committed = await durable.reconcile(reconciliationInput("legacy-r4-evidence-e"));
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  return {
    action: committed.supervisor.action,
    evidenceId: supervisor.snapshot.reconciliationEvidenceId,
    admissionResolution: supervisor.snapshot.reconciliationAdmissionResolution,
  };
}

export async function continueLegacyReconciliation(env: WorkerdEnv) {
  const runId = legacyReconciliationRunId;
  const durable = durableFor(env, runId);
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const checkpoint = current.snapshot.checkpoint;
  await prepareFailedPublication(env, runId, checkpoint, "legacy-r4-prepared-b", publisher2b);
  const reconciled = await durable.reconcile(reconciliationInput("legacy-r4-evidence-f"));
  await prepareFailedPublication(env, runId, checkpoint, "legacy-r4-prepared-c", publisher2c);
  const latest = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  return {
    replayFAction: reconciled.supervisor.action,
    latestEvidenceId: latest.snapshot.reconciliationEvidenceId,
    lifecycle: latest.snapshot.lifecycle,
    preparedFacet: latest.snapshot.preparedFacet,
  };
}

async function inspectCurrent(env: WorkerdEnv) {
  const runId = legacyReconciliationRunId;
  const durable = durableFor(env, runId);
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const files = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });
  const publication = await durable.readPublication({
    control: control2,
    operationId: "legacy-r4-prepared-c",
  });
  return {
    supervisor: {
      lifecycle: supervisor.snapshot.lifecycle,
      generation: supervisor.snapshot.generation,
      checkpoint: supervisor.snapshot.checkpoint,
      preparedFacet: supervisor.snapshot.preparedFacet,
      admittedStepId: supervisor.snapshot.admittedStepId,
      reconciliationEvidenceId: supervisor.snapshot.reconciliationEvidenceId,
      reconciliationAdmissionResolution: supervisor.snapshot.reconciliationAdmissionResolution,
      settlement: supervisor.snapshot.settlement,
    },
    files: {
      checkpoint: files.checkpoint,
      activeStepId: files.activeStepId,
      admissionResolution: files.admissionResolution,
      publication: publication.publication,
    },
  };
}

export async function replayLegacyReconciliation(env: WorkerdEnv) {
  const runId = legacyReconciliationRunId;
  const durable = durableFor(env, runId);
  const before = await inspectCurrent(env);
  const replayE = await durable.reconcile(reconciliationInput("legacy-r4-evidence-e"));
  const alteredE = await failed(() =>
    durable.reconcile(reconciliationInput("legacy-r4-evidence-e", { ...clean, disposed: false })),
  );
  const replayF = await durable.reconcile(reconciliationInput("legacy-r4-evidence-f"));
  const blockedReplacement = await failed(() =>
    durable.threadSupervisor.execute({
      type: "prepareFreshFacet",
      runId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: "legacy-r4-replacement-before-c",
      preparedPublisher: publisher2d,
    }),
  );
  const after = await inspectCurrent(env);

  const reconciledC = await durable.reconcile(reconciliationInput("legacy-r4-evidence-c"));
  const replacementAfterC = await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "legacy-r4-replacement-after-c",
    preparedPublisher: publisher2d,
  });
  const receiptAfterC = await failed(() =>
    durable.readPublication({ control: control2, operationId: "legacy-r4-prepared-c" }),
  );

  return {
    replayEAction: replayE.supervisor.action,
    replayEFiles: replayE.files,
    alteredECode: alteredE.code,
    replayFAction: replayF.supervisor.action,
    replayFFiles: replayF.files,
    blockedReplacementCode: blockedReplacement.code,
    before,
    after,
    cSpecificReconcile: reconciledC.supervisor.action,
    replacementAfterC: replacementAfterC.action,
    receiptGoneAfterC: receiptAfterC.code === "MISSING",
  };
}

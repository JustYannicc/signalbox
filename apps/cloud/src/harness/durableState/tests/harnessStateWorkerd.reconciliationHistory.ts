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
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";

const publisher2b = {
  generation: 2,
  facetNonce: "workerd-history-facet-2b",
  publisherKey: "workerd-history-publisher-2b-workerd-history-publisher-2b-",
};
const publisher2c = {
  generation: 2,
  facetNonce: "workerd-history-facet-2c",
  publisherKey: "workerd-history-publisher-2c-workerd-history-publisher-2c-",
};
const publisher2d = {
  generation: 2,
  facetNonce: "workerd-history-facet-2d",
  publisherKey: "workerd-history-publisher-2d-workerd-history-publisher-2d-",
};
const incomplete = { ...clean, invocationRpcJoined: false, disposed: false };

async function prepareFailedPublication(
  env: WorkerdEnv,
  runId: string,
  durable: ReturnType<typeof durableFor>,
  checkpoint: Awaited<ReturnType<typeof initialize>>["files"]["checkpoint"],
  operationId: string,
  preparedPublisher: typeof publisher2,
) {
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

function input(evidenceId: string, preparedFacetCleanup = clean) {
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

export async function prepareReconciliationHistory(env: WorkerdEnv) {
  const runId = "workerd-reconciliation-history-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "history-initial-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    requestId: "history-stop-request",
    acknowledgementId: "history-stop-acknowledgement",
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

  await prepareFailedPublication(env, runId, durable, checkpoint, "history-prepared-a", publisher2);
  await durable.reconcile(input("history-evidence-e"));
  await prepareFailedPublication(
    env,
    runId,
    durable,
    checkpoint,
    "history-prepared-b",
    publisher2b,
  );
  await durable.reconcile(input("history-evidence-f"));
  await prepareFailedPublication(
    env,
    runId,
    durable,
    checkpoint,
    "history-prepared-c",
    publisher2c,
  );

  return { prepared: "C", checkpoint: checkpoint.checkpointId };
}

export async function replayReconciliationHistory(env: WorkerdEnv) {
  const runId = "workerd-reconciliation-history-proof";
  const durable = durableFor(env, runId);
  const beforeSupervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const beforePublication = await durable.readPublication({
    control: control2,
    operationId: "history-prepared-c",
  });
  const beforeCheckpoint = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });

  const replayE = await durable.reconcile(input("history-evidence-e"));
  const replayF = await durable.reconcile(input("history-evidence-f"));
  const changedE = await failed(() =>
    durable.reconcile(input("history-evidence-e", { ...clean, disposed: false })),
  );
  const changedF = await failed(() =>
    durable.reconcile({ ...input("history-evidence-f"), invocationSettlement: null }),
  );
  const blockedReplacement = await failed(() =>
    durable.threadSupervisor.execute({
      type: "prepareFreshFacet",
      runId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: "replacement-before-c-evidence",
      preparedPublisher: publisher2d,
    }),
  );

  const afterSupervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const afterPublication = await durable.readPublication({
    control: control2,
    operationId: "history-prepared-c",
  });
  const afterCheckpoint = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });

  const reconciledC = await durable.reconcile(input("history-evidence-c"));
  const replacementAfterC = await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "replacement-after-c-evidence",
    preparedPublisher: publisher2d,
  });

  return {
    replayEAction: replayE.supervisor.action,
    replayFAction: replayF.supervisor.action,
    changedECode: changedE.code,
    changedFCode: changedF.code,
    blockedReplacementCode: blockedReplacement.code,
    before: {
      preparedFacet: beforeSupervisor.snapshot.preparedFacet,
      lifecycle: beforeSupervisor.snapshot.lifecycle,
      checkpoint: beforeSupervisor.snapshot.checkpoint,
      admittedStepId: beforeSupervisor.snapshot.admittedStepId,
      admissionResolution: beforeCheckpoint.admissionResolution,
      activeStepId: beforeCheckpoint.activeStepId,
      publication: beforePublication.publication,
    },
    after: {
      preparedFacet: afterSupervisor.snapshot.preparedFacet,
      lifecycle: afterSupervisor.snapshot.lifecycle,
      checkpoint: afterSupervisor.snapshot.checkpoint,
      admittedStepId: afterSupervisor.snapshot.admittedStepId,
      admissionResolution: afterCheckpoint.admissionResolution,
      activeStepId: afterCheckpoint.activeStepId,
      publication: afterPublication.publication,
    },
    cSpecificReconcile: reconciledC.supervisor.action,
    replacementAfterC: replacementAfterC.action,
    receiptGoneAfterC:
      (
        await failed(() =>
          durable.readPublication({ control: control2, operationId: "history-prepared-c" }),
        )
      ).code === "MISSING",
  };
}

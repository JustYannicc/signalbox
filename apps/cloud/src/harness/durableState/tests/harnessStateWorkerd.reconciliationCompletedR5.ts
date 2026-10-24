import {
  control1,
  control2,
  durableFor,
  failed,
  initialize,
  joins,
  publisher1,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import { loseNextFilesReply } from "./harnessStateWorkerd.faults.ts";

export const completedR5RunId = "workerd-completed-reconciliation-r5";
export const completedR5EvidenceId = "completed-r5-evidence-e";
const completedR5StepId = "completed-r5-step-s";
const completedR5CheckpointId = "workerd-completed-r5-q";

const hasType = (command: unknown, type: string) =>
  typeof command === "object" && command !== null && "type" in command && command.type === type;
const isAdmissionWrite = (command: unknown) =>
  hasType(command, "reconcileAdmission") &&
  !(
    typeof command === "object" &&
    command !== null &&
    "validateOnly" in command &&
    command.validateOnly === true
  );

function completedInput(checkpoint: { checkpointId: string; manifestSha256: string }) {
  return {
    control: control2,
    expectedGeneration: 1,
    evidenceId: completedR5EvidenceId,
    outcome: "completed" as const,
    checkpoint,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  };
}

async function readCheckpoint(env: WorkerdEnv, checkpointId: string) {
  return env.HARNESS_FILES_STORE.getByName(completedR5RunId).execute({
    type: "readCheckpoint",
    runId: completedR5RunId,
    publisher: publisher1,
    checkpointId,
  });
}

export async function prepareCompletedR5LostReply(env: WorkerdEnv) {
  const durable = durableFor(env, completedR5RunId);
  const initialized = await initialize(durable, completedR5RunId);
  const prior = initialized.files.checkpoint;
  await durable.admitStep({
    control: control1,
    stepId: completedR5StepId,
    expectedCheckpointId: prior.checkpointId,
  });
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "completed-r5-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: completedR5RunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    ...joins,
  });

  const committed = await env.HARNESS_FILES_STORE.getByName(completedR5RunId).execute({
    type: "writeCheckpoint",
    runId: completedR5RunId,
    publisher: publisher1,
    stepId: completedR5StepId,
    expectedCheckpointId: prior.checkpointId,
    checkpoint: {
      checkpointId: completedR5CheckpointId,
      parentCheckpointId: prior.checkpointId,
      files: [
        {
          path: "src/proof.ts",
          mode: 0o644,
          bytes: new TextEncoder().encode("export const proof = 'Q';\n"),
        },
      ],
    },
  });
  const supervisorBeforeReconcile = await durable.threadSupervisor.execute({
    type: "read",
    runId: completedR5RunId,
    control: control2,
  });
  const lostReply = await failed(() =>
    durableFor(loseNextFilesReply(env, isAdmissionWrite), completedR5RunId).reconcile(
      completedInput(committed.checkpoint),
    ),
  );
  const filesAfterLostReply = await readCheckpoint(env, completedR5CheckpointId);
  const supervisorAfterLostReply = await durable.threadSupervisor.execute({
    type: "read",
    runId: completedR5RunId,
    control: control2,
  });

  return {
    runId: completedR5RunId,
    lostReplyCode: lostReply.code,
    checkpointP: prior,
    checkpointQ: committed.checkpoint,
    parentCheckpointId: committed.parentCheckpointId,
    filesResolution: filesAfterLostReply.admissionResolution,
    before: {
      checkpoint: supervisorBeforeReconcile.snapshot.checkpoint,
      admittedStepId: supervisorBeforeReconcile.snapshot.admittedStepId,
      lifecycle: supervisorBeforeReconcile.snapshot.lifecycle,
    },
    after: {
      checkpoint: supervisorAfterLostReply.snapshot.checkpoint,
      admittedStepId: supervisorAfterLostReply.snapshot.admittedStepId,
      lifecycle: supervisorAfterLostReply.snapshot.lifecycle,
      reconciliationEvidenceId: supervisorAfterLostReply.snapshot.reconciliationEvidenceId,
    },
  };
}

export async function replayCompletedR5AfterEviction(env: WorkerdEnv) {
  const durable = durableFor(env, completedR5RunId);
  const prior = await readCheckpoint(env, "workerd-checkpoint-1");
  const checkpoint = await readCheckpoint(env, completedR5CheckpointId);
  const replay = await durable.reconcile(completedInput(checkpoint.checkpoint));
  const beforeChangedSupervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId: completedR5RunId,
    control: control2,
  });
  const beforeChangedFiles = await readCheckpoint(env, completedR5CheckpointId);
  const changed = await failed(() =>
    durable.reconcile({
      ...completedInput(checkpoint.checkpoint),
      invocationSettlement: { ...joins, fetchJoined: false },
    }),
  );
  const afterChangedSupervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId: completedR5RunId,
    control: control2,
  });
  const afterChangedFiles = await readCheckpoint(env, completedR5CheckpointId);
  const wrongControl = await failed(() =>
    durable.reconcile({
      ...completedInput(checkpoint.checkpoint),
      control: { ...control2, controlKey: "workerd-wrong-control-key-r5".repeat(2) },
    }),
  );

  const later = await durable.reconcile({
    control: control2,
    expectedGeneration: 1,
    evidenceId: "completed-r5-evidence-f",
    outcome: "notApplied",
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  });
  const beforeHistoricalReplay = await readCheckpoint(env, completedR5CheckpointId);
  const historicalReplay = await env.HARNESS_FILES_STORE.getByName(completedR5RunId).execute({
    type: "reconcileAdmission",
    runId: completedR5RunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    evidenceId: completedR5EvidenceId,
    stepId: completedR5StepId,
    outcome: "completed",
    expectedCheckpoint: prior.checkpoint,
    checkpoint: checkpoint.checkpoint,
  });
  const wrongPublisher = await failed(() =>
    env.HARNESS_FILES_STORE.getByName(completedR5RunId).execute({
      type: "reconcileAdmission",
      runId: completedR5RunId,
      control: control2,
      publisher: { ...publisher1, facetNonce: "workerd-wrong-facet-nonce-r5" },
      expectedGeneration: 1,
      evidenceId: completedR5EvidenceId,
      stepId: completedR5StepId,
      outcome: "completed",
      expectedCheckpoint: prior.checkpoint,
      checkpoint: checkpoint.checkpoint,
    }),
  );
  const afterHistoricalReplay = await readCheckpoint(env, completedR5CheckpointId);

  return {
    replayAction: replay.supervisor.action,
    replaySupervisor: {
      lifecycle: replay.supervisor.snapshot.lifecycle,
      checkpoint: replay.supervisor.snapshot.checkpoint,
      admittedStepId: replay.supervisor.snapshot.admittedStepId,
      preparedFacet: replay.supervisor.snapshot.preparedFacet,
      reconciliationEvidenceId: replay.supervisor.snapshot.reconciliationEvidenceId,
      reconciliationAdmissionResolution:
        replay.supervisor.snapshot.reconciliationAdmissionResolution,
    },
    replayFilesResolution: replay.files?.admissionResolution ?? null,
    changedCode: changed.code,
    changedBefore: beforeChangedSupervisor.snapshot,
    changedAfter: afterChangedSupervisor.snapshot,
    changedFilesBefore: beforeChangedFiles.admissionResolution,
    changedFilesAfter: afterChangedFiles.admissionResolution,
    wrongControlCode: wrongControl.code,
    laterEvidenceId: later.supervisor.snapshot.reconciliationEvidenceId,
    beforeHistoricalReplay: beforeHistoricalReplay.admissionResolution,
    historicalReplayAction: historicalReplay.action,
    historicalReplayResult: historicalReplay.admissionResolution,
    wrongPublisherCode: wrongPublisher.code,
    afterHistoricalReplay: afterHistoricalReplay.admissionResolution,
  };
}

export async function reconcileCompletedNullStepR5(env: WorkerdEnv) {
  const runId = "workerd-completed-null-step-r5";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "completed-r5-null-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    ...joins,
  });
  const input = {
    control: control2,
    expectedGeneration: 1,
    evidenceId: "completed-r5-null-evidence",
    outcome: "completed" as const,
    checkpoint: initialized.files.checkpoint,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  };
  const reconciled = await durable.reconcile(input);
  const replay = await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "reconcileAdmission",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    evidenceId: input.evidenceId,
    outcome: input.outcome,
    checkpoint: input.checkpoint,
    stepId: null,
    expectedCheckpoint: initialized.files.checkpoint,
  });
  return {
    lifecycle: reconciled.supervisor.snapshot.lifecycle,
    replayAction: replay.action,
    replayResolution: replay.admissionResolution,
  };
}

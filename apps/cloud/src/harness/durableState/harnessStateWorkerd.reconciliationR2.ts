import {
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
import { failNextSupervisorBefore, loseNextFilesReply } from "./harnessStateWorkerd.faults.ts";

const hasType = (command: unknown, type: string) =>
  typeof command === "object" && command !== null && "type" in command && command.type === type;

async function settleUnknown(durable: ReturnType<typeof durableFor>, runId: string) {
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    ...joins,
  });
}

export async function reconcileAdmissionRecovery(env: WorkerdEnv) {
  const runId = "workerd-admission-recovery-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  const admitted = await durable.admitStep({
    control: control1,
    stepId: "admitted-before-reconcile",
    expectedCheckpointId: checkpoint.checkpointId,
  });
  const drain = await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "drain-admission-recovery",
    nextControl: control2,
  });
  await settleUnknown(durable, runId);

  const input = {
    control: control2,
    expectedGeneration: 1,
    evidenceId: "admission-recovery-evidence",
    outcome: "notApplied" as const,
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  };
  const lostReply = await failed(() =>
    durableFor(
      loseNextFilesReply(env, (command) => hasType(command, "reconcileAdmission")),
      runId,
    ).reconcile(input),
  );
  const resumed = durableFor(env, runId);
  const filesAfterLostReply = await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: checkpoint.checkpointId,
  });
  const retry = await resumed.reconcile(input);
  const filesAfterRetry = await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: checkpoint.checkpointId,
  });

  const operationId = "resume-after-admission-reconcile";
  await resumed.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId,
    preparedPublisher: publisher2,
  });
  const published = await resumed.publishFreshFacet({
    control: control2,
    operationId,
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint,
  });
  const activation = await resumed.recordActivation({ control: control2, operationId });
  const staleCommit = await failed(() =>
    resumed.commitCheckpoint({
      publisher: publisher1,
      stepId: "stale-step-after-reconcile",
      expectedCheckpointId: checkpoint.checkpointId,
      checkpoint: {
        checkpointId: "stale-publisher-checkpoint",
        parentCheckpointId: checkpoint.checkpointId,
        files: [],
      },
    }),
  );

  return {
    admission: admitted.status,
    drain: drain.status,
    lostFilesReplyCode: lostReply.code,
    persistedAfterLostReply: {
      checkpoint: filesAfterLostReply.checkpoint,
      activeStepId: filesAfterLostReply.activeStepId,
      resolution: filesAfterLostReply.admissionResolution,
    },
    retryAction: retry.supervisor.action,
    persistedAfterRetry: {
      checkpoint: filesAfterRetry.checkpoint,
      activeStepId: filesAfterRetry.activeStepId,
      resolution: filesAfterRetry.admissionResolution,
    },
    publication: published.status,
    activation: activation.status,
    stalePublisherCommitCode: staleCommit.code,
  };
}

export async function reconcileCompletedCheckpoint(env: WorkerdEnv) {
  const runId = "workerd-completed-checkpoint-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint1 = initialized.files.checkpoint;
  await durable.admitStep({
    control: control1,
    stepId: "completed-before-supervisor-reconcile",
    expectedCheckpointId: checkpoint1.checkpointId,
  });
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "drain-completed-checkpoint",
    nextControl: control2,
  });

  const write = await durableFor(
    failNextSupervisorBefore(env, (command) => hasType(command, "commitCheckpoint")),
    runId,
  ).commitCheckpoint({
    publisher: publisher1,
    stepId: "completed-before-supervisor-reconcile",
    expectedCheckpointId: checkpoint1.checkpointId,
    checkpoint: {
      checkpointId: "workerd-completed-checkpoint-2",
      parentCheckpointId: checkpoint1.checkpointId,
      files: [],
    },
  });
  await settleUnknown(durable, runId);
  const checkpoint2 = write.files.checkpoint;
  const wrongCheckpoint = await failed(() =>
    durable.reconcile({
      control: control2,
      expectedGeneration: 1,
      evidenceId: "completed-checkpoint-evidence",
      outcome: "completed",
      checkpoint: {
        checkpointId: "not-the-files-checkpoint",
        manifestSha256: "c".repeat(64),
      },
      invocationSettlement: joins,
      preparedFacetCleanup: null,
    }),
  );
  const filesAfterMismatch = await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: checkpoint2.checkpointId,
  });
  const reconciled = await durable.reconcile({
    control: control2,
    expectedGeneration: 1,
    evidenceId: "completed-checkpoint-evidence",
    outcome: "completed",
    checkpoint: checkpoint2,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  });

  return {
    partialCommitStatus: write.status,
    wrongCheckpointCode: wrongCheckpoint.code,
    filesAfterMismatch: {
      checkpoint: filesAfterMismatch.checkpoint,
      admissionResolution: filesAfterMismatch.admissionResolution,
    },
    reconciledLifecycle: reconciled.supervisor.snapshot.lifecycle,
    reconciledCheckpoint: reconciled.supervisor.snapshot.checkpoint,
    filesAdmissionResolution: reconciled.files?.admissionResolution ?? null,
  };
}

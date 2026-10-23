import {
  control1,
  control2,
  control3,
  durableFor,
  failed,
  initialize,
  publisher1,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import type { HarnessThreadSupervisorControlClaim } from "../HarnessThreadSupervisor.ts";
import { failNextFilesBefore, failNextSupervisorBefore } from "./harnessStateWorkerd.faults.ts";

const hasType = (command: unknown, type: string) =>
  typeof command === "object" && command !== null && "type" in command && command.type === type;

const control4 = {
  ownerId: control1.ownerId,
  incarnationId: "workerd-controller-incarnation-4",
  epoch: 4,
  controlKey: "workerd-controller-control-4-".repeat(2),
} satisfies HarnessThreadSupervisorControlClaim;

export async function repairControlSync(env: WorkerdEnv) {
  const runId = "workerd-control-sync-repair-proof";
  const durable = durableFor(env, runId);
  await initialize(durable, runId);
  const failedFilesWrite = await durableFor(
    failNextFilesBefore(env, (command) => hasType(command, "syncControl")),
    runId,
  ).beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "control-sync-1",
    nextControl: control2,
  });
  const recovered = durableFor(env, runId);
  const supervisorAfterFailure = await recovered.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const filesBeforeRepair = await failed(() =>
    recovered.readPublication({ control: control2, operationId: "missing-publication" }),
  );
  const staleKey = await failed(() =>
    recovered.readPublication({
      control: { ...control2, controlKey: "workerd-mismatched-controller-key-123456" },
      operationId: "missing-publication",
    }),
  );
  const skippedEpoch = await failed(() =>
    recovered.beginDrain({
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: "control-sync-skip-epoch",
      nextControl: control4,
    }),
  );
  const filesAfterRepair = await failed(() =>
    recovered.readPublication({ control: control2, operationId: "missing-publication" }),
  );
  const secondTakeover = await recovered.beginDrain({
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "control-sync-2",
    nextControl: control3,
  });
  const supervisorAfterSecondTakeover = await recovered.threadSupervisor.execute({
    type: "read",
    runId,
    control: control3,
  });
  const filesAtThirdEpoch = await failed(() =>
    recovered.readPublication({ control: control3, operationId: "missing-publication" }),
  );

  return {
    firstStatus: failedFilesWrite.status,
    firstFailureCode:
      failedFilesWrite.status === "files-pending" ? failedFilesWrite.failure.code : null,
    pendingSync: supervisorAfterFailure.snapshot.pendingControlSync,
    filesBeforeRepairCode: filesBeforeRepair.code,
    staleKeyCode: staleKey.code,
    skippedEpochCode: skippedEpoch.code,
    filesAfterRepairCode: filesAfterRepair.code,
    secondTakeoverStatus: secondTakeover.status,
    finalControlEpoch: supervisorAfterSecondTakeover.snapshot.controlEpoch,
    finalPendingSync: supervisorAfterSecondTakeover.snapshot.pendingControlSync,
    filesAtThirdEpochCode: filesAtThirdEpoch.code,
  };
}

export async function rejectMismatchedControlSyncOperation(env: WorkerdEnv) {
  const runId = "workerd-control-sync-operation-proof";
  const durable = durableFor(env, runId);
  await initialize(durable, runId);
  const firstAttempt = await durableFor(
    failNextSupervisorBefore(env, (command) => hasType(command, "confirmControlSync")),
    runId,
  ).beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "control-sync-operation-1",
    nextControl: control2,
  });
  const recovered = durableFor(env, runId);
  const wrongOperation = await failed(() =>
    env.HARNESS_FILES_STORE.getByName(runId).execute({
      type: "syncControl",
      runId,
      control: control2,
      fromEpoch: control1.epoch,
      fromIncarnationId: control1.incarnationId,
      expectedGeneration: 1,
      operationId: "wrong-control-sync-operation",
      publication: null,
      preparedPublication: null,
    }),
  );
  const repaired = await recovered.beginDrain({
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "control-sync-operation-2",
    nextControl: control3,
  });
  const finalFilesControl = await failed(() =>
    recovered.readPublication({ control: control3, operationId: "missing-publication" }),
  );
  return {
    firstStatus: firstAttempt.status,
    wrongOperationCode: wrongOperation.code,
    repairedStatus: repaired.status,
    finalFilesLookupCode: finalFilesControl.code,
  };
}

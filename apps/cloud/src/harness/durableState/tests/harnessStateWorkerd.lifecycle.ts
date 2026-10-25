import {
  control1,
  control2,
  control3,
  durableFor,
  failed,
  initialize,
  publisher1,
  publisher2,
  publisher3,
  stopAndPrepare,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";

export async function lifecycle(env: WorkerdEnv) {
  const runId = "workerd-lifecycle-proof";
  const durable = durableFor(env, runId);
  const invalidRunIdFailure = await failed(async () => {
    durableFor(env, "");
  });
  const initialized = await initialize(durable, runId);
  const checkpoint1 = initialized.files.checkpoint;
  let invalidInitialize: Promise<unknown> | undefined;
  let initializationSynchronousThrow = false;
  try {
    invalidInitialize = durable.initialize({
      run: { seed: { identity: { runId: "another-run" } } },
    } as never);
  } catch {
    initializationSynchronousThrow = true;
  }
  const initializationFailure = await failed(() => invalidInitialize ?? Promise.resolve());
  let forbiddenFilesCommand: Promise<unknown> | undefined;
  let filesSynchronousThrow = false;
  try {
    forbiddenFilesCommand = durable.filesStore.execute({ type: "publishFacet" } as never);
  } catch {
    filesSynchronousThrow = true;
  }
  const filesFailure = await failed(() => forbiddenFilesCommand ?? Promise.resolve());
  let rawReconcile: Promise<unknown> | undefined;
  let reconcileSynchronousThrow = false;
  try {
    rawReconcile = durable.threadSupervisor.execute({ type: "reconcile" } as never);
  } catch {
    reconcileSynchronousThrow = true;
  }
  const rawReconcileFailure = await failed(() => rawReconcile ?? Promise.resolve());
  await stopAndPrepare(durable, runId, control1, publisher1, control2, "resume-1", publisher2);
  const wrongControl = {
    ...control2,
    controlKey: "workerd-mismatched-control-key-123456789",
  };
  const wrongKeyFailure = await failed(() =>
    durable.publishFreshFacet({
      control: wrongControl,
      operationId: "resume-1",
      verifiedNativeSessionId: "workerd-native-session",
      checkpoint: checkpoint1,
    }),
  );
  const published2 = await durable.publishFreshFacet({
    control: control2,
    operationId: "resume-1",
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint: checkpoint1,
  });
  const activated2 = await durable.recordActivation({ control: control2, operationId: "resume-1" });
  const admitted = await durable.admitStep({
    control: control2,
    stepId: "step-1",
    expectedCheckpointId: checkpoint1.checkpointId,
  });
  const checkpoint2 = await durable.commitCheckpoint({
    publisher: publisher2,
    stepId: "step-1",
    expectedCheckpointId: checkpoint1.checkpointId,
    checkpoint: {
      checkpointId: "workerd-checkpoint-2",
      parentCheckpointId: checkpoint1.checkpointId,
      files: [],
    },
  });
  const oldPublisher = await failed(() =>
    durable.filesStore.execute({
      type: "recoverCheckpoint",
      runId,
      publisher: publisher1,
      checkpointId: checkpoint1.checkpointId,
    }),
  );
  await stopAndPrepare(durable, runId, control2, publisher2, control3, "resume-2", publisher3);
  const published3 = await durable.publishFreshFacet({
    control: control3,
    operationId: "resume-2",
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint: checkpoint2.files.checkpoint,
  });
  const activated3 = await durable.recordActivation({ control: control3, operationId: "resume-2" });
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control3,
  });
  return {
    invalidRunIdCode: invalidRunIdFailure.code,
    initializationSynchronousThrow,
    initializationCode: initializationFailure.code,
    filesSynchronousThrow,
    forbiddenFilesCode: filesFailure.code,
    forbiddenFilesErrorName: filesFailure.name,
    reconcileSynchronousThrow,
    rawReconcileCode: rawReconcileFailure.code,
    wrongKeyCode: wrongKeyFailure.code,
    wrongKeyMessageContainsKey: wrongKeyFailure.message.includes(wrongControl.controlKey),
    publication2: published2.status,
    publicationControl2: published2.status === "published" ? published2.control : null,
    publication2Evidence:
      published2.status === "published"
        ? {
            nativeSessionId: published2.supervisor.snapshot.nativeSessionId,
            receipt: published2.receipt,
          }
        : null,
    activation2: activated2.status,
    admission: admitted.status,
    checkpoint2: checkpoint2.files.checkpoint,
    oldPublisherCode: oldPublisher.code,
    publication3: published3.status,
    publicationControl3: published3.status === "published" ? published3.control : null,
    publication3Evidence:
      published3.status === "published"
        ? {
            nativeSessionId: published3.supervisor.snapshot.nativeSessionId,
            receipt: published3.receipt,
          }
        : null,
    activation3: activated3.status,
    snapshotContainsControlKey: JSON.stringify(supervisor.snapshot).includes(control3.controlKey),
    snapshot: supervisor.snapshot,
  };
}

export async function handoff(env: WorkerdEnv) {
  const runId = "workerd-handoff-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  await stopAndPrepare(durable, runId, control1, publisher1, control2, "resume-1", publisher2);
  const files = env.HARNESS_FILES_STORE.getByName(runId);
  await files.execute({
    type: "publishFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher: publisher2,
    operationId: "resume-1",
    checkpoint,
  });
  await env.HARNESS_THREAD_SUPERVISOR.getByName(runId).execute({
    type: "publishFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "resume-1",
    preparedPublisher: publisher2,
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint,
  });
  const secondWriteFailure = await failed(() =>
    files.execute({
      type: "confirmFacetPublication",
      runId,
      control: control2,
      expectedGeneration: 1,
      preparedPublisher: publisher2,
      operationId: "wrong-operation",
      checkpoint,
    }),
  );
  const mismatchedReceipt = await failed(() =>
    files.execute({
      type: "syncControl",
      runId,
      control: control3,
      fromEpoch: control2.epoch,
      fromIncarnationId: control2.incarnationId,
      expectedGeneration: 2,
      operationId: "wrong-handoff",
      publication: {
        operationId: "resume-1",
        fromGeneration: 1,
        toGeneration: 2,
        priorFacetNonce: publisher1.facetNonce,
        preparedFacetNonce: "wrong-facet-nonce",
        checkpoint,
      },
      preparedPublication: null,
    }),
  );
  await durable.beginDrain({
    control: control2,
    publisher: publisher2,
    expectedGeneration: 2,
    operationId: "takeover-after-publication",
    nextControl: control3,
  });
  const staleClaim = await failed(() =>
    durable.readPublication({ control: control2, operationId: "resume-1" }),
  );
  const stalePublication = await failed(() =>
    durable.publishFreshFacet({
      control: control2,
      operationId: "resume-1",
      verifiedNativeSessionId: "workerd-native-session",
      checkpoint,
    }),
  );
  const repaired = await durable.publishFreshFacet({
    control: control3,
    operationId: "resume-1",
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint,
  });
  return {
    secondWriteFailureCode: secondWriteFailure.code,
    mismatchedReceiptCode: mismatchedReceipt.code,
    staleClaimCode: staleClaim.code,
    stalePublicationCode: stalePublication.code,
    repairStatus: repaired.status,
    repairControl: repaired.status === "published" ? repaired.control : null,
    receipt: repaired.status === "published" ? repaired.receipt : null,
  };
}

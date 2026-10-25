import type {
  HarnessDurableStateActivationInput,
  HarnessDurableStateActivationResult,
  HarnessDurableStateCheckpointInput,
  HarnessDurableStateCheckpointResult,
  HarnessDurableStateDrainInput,
  HarnessDurableStateDrainResult,
  HarnessDurableStateFailureInput,
  HarnessDurableStateInitializationInput,
  HarnessDurableStateInitializationResult,
  HarnessDurableStateStepInput,
  HarnessDurableStateStepResult,
  HarnessDurableStateStubs,
} from "./types.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import { HarnessDurableStateError, failureOf, hasCode } from "./errors.ts";
import { syncPendingControl } from "./controlSync.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function initialize(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateInitializationInput,
): Promise<HarnessDurableStateInitializationResult> {
  if (input.run.seed.identity.runId !== stores.runId)
    throw new HarnessDurableStateError({ code: "CONFLICT" });
  const journal = await stores.runStore.execute(input.run);
  const files = await stores.filesStore.execute({
    type: "initialize",
    runId: stores.runId,
    control: input.control,
    publisher: input.publisher,
    checkpoint: input.checkpoint,
  });
  const supervisor = await stores.threadSupervisor.execute({
    type: "initialize",
    runId: stores.runId,
    nativeSessionId: input.nativeSessionId,
    control: input.control,
    publisher: input.publisher,
    checkpoint: files.checkpoint,
  });
  return {
    journal,
    files,
    supervisor,
  };
}

export async function beginDrain(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateDrainInput,
): Promise<HarnessDurableStateDrainResult> {
  let current: HarnessThreadSupervisorResult | null = null;
  try {
    current = await stores.threadSupervisor.execute({
      type: "read",
      runId: stores.runId,
      control: input.control,
    });
  } catch (error) {
    if (!hasCode(error, "STALE_CONTROL")) throw error;
  }
  if (current?.snapshot.pendingControlSync) {
    const repaired = await syncPendingControl(stores, input.control, current);
    if (repaired.status === "files-pending")
      return {
        status: "files-pending",
        supervisor: repaired.supervisor,
        failure: repaired.failure,
      };
  }

  const supervisor = await stores.threadSupervisor.execute({
    type: "beginDrain",
    runId: stores.runId,
    ...input,
  });
  const synchronized = await syncPendingControl(stores, input.nextControl, supervisor);
  if (synchronized.status === "files-pending")
    return {
      status: "files-pending",
      supervisor: synchronized.supervisor,
      failure: synchronized.failure,
    };
  return { status: "draining", supervisor: synchronized.supervisor, files: synchronized.files };
}

export async function admitStep(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateStepInput,
): Promise<HarnessDurableStateStepResult> {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  if (
    current.snapshot.lifecycle !== "accepting" ||
    current.snapshot.checkpoint.checkpointId !== input.expectedCheckpointId
  )
    throw new HarnessDurableStateError({ code: "OUT_OF_ORDER" });
  const supervisor = await stores.threadSupervisor.execute({
    type: "admitStep",
    runId: stores.runId,
    publisher: current.currentPublisher,
    stepId: input.stepId,
    expectedCheckpointId: input.expectedCheckpointId,
  });
  try {
    const files = await stores.filesStore.execute({
      type: "admitStep",
      runId: stores.runId,
      publisher: current.currentPublisher,
      stepId: input.stepId,
      expectedCheckpointId: input.expectedCheckpointId,
    });
    return { status: "admitted", supervisor, files };
  } catch (error) {
    return { status: "files-pending", supervisor, failure: failureOf(error) };
  }
}

export async function commitCheckpoint(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateCheckpointInput,
): Promise<HarnessDurableStateCheckpointResult> {
  const files = await stores.filesStore.execute({
    type: "writeCheckpoint",
    runId: stores.runId,
    publisher: input.publisher,
    stepId: input.stepId,
    expectedCheckpointId: input.expectedCheckpointId,
    checkpoint: input.checkpoint,
  });
  try {
    const supervisor = await stores.threadSupervisor.execute({
      type: "commitCheckpoint",
      runId: stores.runId,
      publisher: input.publisher,
      stepId: input.stepId,
      expectedCheckpointId: input.expectedCheckpointId,
      checkpoint: files.checkpoint,
    });
    if (!same(supervisor.snapshot.checkpoint, files.checkpoint))
      return {
        status: "supervisor-pending",
        files,
        failure: { code: "CONFLICT", message: "Checkpoint authorities do not match." },
      };
    return { status: "committed", files, supervisor };
  } catch (error) {
    return { status: "supervisor-pending", files, failure: failureOf(error) };
  }
}

export async function recordActivation(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateActivationInput,
): Promise<HarnessDurableStateActivationResult> {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  if (
    current.snapshot.lastPublicationOperationId !== input.operationId ||
    (current.snapshot.lifecycle !== "published" &&
      current.snapshot.lifecycle !== "activation-failed" &&
      current.snapshot.lifecycle !== "accepting")
  )
    throw new HarnessDurableStateError({ code: "OUT_OF_ORDER" });
  const files = await stores.filesStore.execute({
    type: "recordActivation",
    runId: stores.runId,
    control: input.control,
    publisher: current.currentPublisher,
    expectedGeneration: current.snapshot.generation,
    operationId: input.operationId,
  });
  try {
    const supervisor = await stores.threadSupervisor.execute({
      type: "recordActivation",
      runId: stores.runId,
      control: input.control,
      publisher: current.currentPublisher,
      expectedGeneration: current.snapshot.generation,
      operationId: input.operationId,
    });
    if (supervisor.snapshot.lifecycle !== "accepting")
      return {
        status: "files-pending",
        supervisor,
        failure: { code: "CONFLICT", message: "Supervisor activation is not committed." },
      };
    return { status: "accepting", files, supervisor };
  } catch (error) {
    return {
      status: "files-pending",
      supervisor: current,
      failure: failureOf(error),
    };
  }
}

export async function recordActivationFailure(
  stores: HarnessDurableStateStubs,
  input: {
    readonly control: HarnessDurableStateFailureInput["control"];
    readonly operationId: string;
    readonly failure: HarnessDurableStateFailureInput["failure"];
  },
) {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  const supervisor = await stores.threadSupervisor.execute({
    type: "recordActivationFailure",
    runId: stores.runId,
    control: input.control,
    publisher: current.currentPublisher,
    expectedGeneration: current.snapshot.generation,
    operationId: input.operationId,
    failure: input.failure,
  });
  await stores.filesStore.execute({
    type: "recordActivationFailure",
    runId: stores.runId,
    control: input.control,
    publisher: current.currentPublisher,
    expectedGeneration: current.snapshot.generation,
    operationId: input.operationId,
  });
  return supervisor;
}

export async function recordPreparedFacetFailure(
  stores: HarnessDurableStateStubs,
  input: HarnessDurableStateFailureInput,
) {
  const current = await stores.threadSupervisor.execute({
    type: "read",
    runId: stores.runId,
    control: input.control,
  });
  const preparedPublisher = current.preparedPublisher;
  if (
    current.snapshot.lifecycle !== "preparing" ||
    current.snapshot.preparedFacet?.operationId !== input.operationId ||
    preparedPublisher === null
  )
    throw new HarnessDurableStateError({ code: "OUT_OF_ORDER" });
  if (
    input.cleanup.stopAcknowledged &&
    input.cleanup.invocationRpcJoined &&
    input.cleanup.fetchJoined &&
    input.cleanup.callbackPortsJoined &&
    input.cleanup.disposed
  ) {
    try {
      const receipt = await stores.filesStore.execute({
        type: "readPublication",
        runId: stores.runId,
        control: input.control,
        operationId: input.operationId,
      });
      if (receipt.publication?.status === "confirmed")
        throw new HarnessDurableStateError({ code: "CONFLICT" });
      if (receipt.publication?.status === "pending")
        await stores.filesStore.execute({
          type: "abortFacetPublication",
          runId: stores.runId,
          control: input.control,
          expectedGeneration: current.snapshot.generation,
          preparedPublisher,
          operationId: input.operationId,
        });
    } catch (error) {
      if (!hasCode(error, "MISSING")) throw error;
    }
  }
  return stores.threadSupervisor.execute({
    type: "recordPreparedFacetFailure",
    runId: stores.runId,
    control: input.control,
    publisher: current.currentPublisher,
    expectedGeneration: current.snapshot.generation,
    operationId: input.operationId,
    phase: input.phase,
    preparedPublisher,
    failure: input.failure,
    cleanup: input.cleanup,
  });
}

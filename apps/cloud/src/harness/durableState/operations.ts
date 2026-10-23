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
} from "../HarnessDurableState.ts";
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";

export interface DurableStateStubs {
  readonly runId: string;
  readonly runStore: { execute(command: unknown): Promise<unknown> };
  readonly filesStore: { execute(command: unknown): Promise<HarnessFilesStoreResult> };
  readonly threadSupervisor: { execute(command: unknown): Promise<HarnessThreadSupervisorResult> };
}

const failureOf = (error: unknown) => {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return { code: error.code, message: error.message.slice(0, 512) };
  if (error instanceof Error) return { code: "STORAGE", message: error.message.slice(0, 512) };
  return { code: "STORAGE", message: "Durable state operation failed." };
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function initialize(
  stores: DurableStateStubs,
  input: HarnessDurableStateInitializationInput,
): Promise<HarnessDurableStateInitializationResult> {
  if (input.run.seed.identity.runId !== stores.runId)
    throw new Error("Run journal initialization targets another run.");
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
    journal: journal as HarnessDurableStateInitializationResult["journal"],
    files,
    supervisor,
  };
}

export async function beginDrain(
  stores: DurableStateStubs,
  input: HarnessDurableStateDrainInput,
): Promise<HarnessDurableStateDrainResult> {
  const supervisor = await stores.threadSupervisor.execute({
    type: "beginDrain",
    runId: stores.runId,
    ...input,
  });
  try {
    const files = await stores.filesStore.execute({
      type: "syncControl",
      runId: stores.runId,
      control: input.nextControl,
      expectedGeneration: input.expectedGeneration,
      operationId: input.operationId,
    });
    return { status: "draining", supervisor, files };
  } catch (error) {
    return { status: "files-pending", supervisor, failure: failureOf(error) };
  }
}

export async function admitStep(
  stores: DurableStateStubs,
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
    throw new Error("The supervisor is not accepting this step.");
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
  stores: DurableStateStubs,
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
  stores: DurableStateStubs,
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
    throw new Error("The current claim has no matching published facet.");
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
  stores: DurableStateStubs,
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
  stores: DurableStateStubs,
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
    throw new Error("The current claim has no matching inert facet.");
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
        throw new Error("Published file authority cannot be rolled back.");
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
      if (!(error instanceof Error && "code" in error && error.code === "MISSING")) throw error;
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

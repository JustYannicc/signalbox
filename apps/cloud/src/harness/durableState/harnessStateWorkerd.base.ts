import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessDurableState, HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";

export type WorkerdEnv = HarnessDurableStateBindings;
export const topologyRunId = "workerd-topology-proof";

export const control1 = {
  ownerId: "workerd-owner",
  incarnationId: "workerd-controller-incarnation-1",
  epoch: 1,
  controlKey: "workerd-controller-control-1-".repeat(2),
} satisfies HarnessThreadSupervisorControlClaim;
export const control2 = {
  ownerId: "workerd-owner",
  incarnationId: "workerd-controller-incarnation-2",
  epoch: 2,
  controlKey: "workerd-controller-control-2-".repeat(2),
} satisfies HarnessThreadSupervisorControlClaim;
export const control3 = {
  ownerId: "workerd-owner",
  incarnationId: "workerd-controller-incarnation-3",
  epoch: 3,
  controlKey: "workerd-controller-control-3-".repeat(2),
} satisfies HarnessThreadSupervisorControlClaim;
export const publisher1 = {
  generation: 1,
  facetNonce: "workerd-facet-nonce-1",
  publisherKey: "workerd-facet-publisher-1-".repeat(2),
} satisfies HarnessThreadSupervisorPublisher;
export const publisher2 = {
  generation: 2,
  facetNonce: "workerd-facet-nonce-2",
  publisherKey: "workerd-facet-publisher-2-".repeat(2),
} satisfies HarnessThreadSupervisorPublisher;
export const publisher2b = {
  generation: 2,
  facetNonce: "workerd-facet-nonce-2b",
  publisherKey: "workerd-facet-publisher-2b-".repeat(2),
} satisfies HarnessThreadSupervisorPublisher;
export const publisher3 = {
  generation: 3,
  facetNonce: "workerd-facet-nonce-3",
  publisherKey: "workerd-facet-publisher-3-".repeat(2),
} satisfies HarnessThreadSupervisorPublisher;
export const checkpointInput = {
  checkpointId: "workerd-checkpoint-1",
  parentCheckpointId: null,
  files: [
    {
      path: "src/proof.ts",
      mode: 0o644,
      bytes: new TextEncoder().encode("export const proof = true;\n"),
    },
  ],
};
export const joins = {
  invocationRpcJoined: true,
  fetchJoined: true,
  callbackPortsJoined: true,
};
export const clean = { stopAcknowledged: true, ...joins, disposed: true };
export const incomplete = { ...clean, invocationRpcJoined: false, disposed: false };

function runInitialization(runId: string) {
  return {
    type: "initialize" as const,
    seed: {
      identity: {
        runId,
        hostId: "workerd-host",
        threadId: "workerd-thread",
        logicalTurnId: "turn-1",
        filesystemId: "workerd-files",
      },
      locator: { id: "locator", sha256: "a".repeat(64), bytes: 1 },
      config: { id: "config", sha256: "b".repeat(64), bytes: 1 },
      artifacts: [],
    },
    controlKey: "workerd-run-control-".repeat(3),
    supervisorKey: "workerd-run-supervisor-".repeat(3),
    claimId: "workerd-claim-1",
    requestId: "workerd-request-1",
  };
}

export const durableFor = (env: WorkerdEnv, runId: string) => createHarnessDurableState(env, runId);

export async function initialize(durable: HarnessDurableState, runId: string) {
  return durable.initialize({
    run: runInitialization(runId),
    nativeSessionId: "workerd-native-session",
    control: control1,
    publisher: publisher1,
    checkpoint: checkpointInput,
  });
}

export async function stopAndPrepare(
  durable: HarnessDurableState,
  runId: string,
  control: HarnessThreadSupervisorControlClaim,
  publisher: HarnessThreadSupervisorPublisher,
  nextControl: HarnessThreadSupervisorControlClaim,
  operationId: string,
  preparedPublisher: HarnessThreadSupervisorPublisher,
) {
  const expectedGeneration = publisher.generation;
  await durable.beginDrain({
    control,
    publisher,
    expectedGeneration,
    operationId: `drain-${operationId}`,
    nextControl,
  });
  await durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId,
    control: nextControl,
    publisher,
    expectedGeneration,
    requestId: `stop-${operationId}`,
    acknowledgementId: `stop-ack-${operationId}`,
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: nextControl,
    publisher,
    expectedGeneration,
    outcome: "stopped",
    ...joins,
  });
  await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: nextControl,
    publisher,
    expectedGeneration,
    operationId,
    preparedPublisher,
  });
}

export const errorCode = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

export async function failed(operation: () => Promise<unknown>) {
  try {
    await operation();
    return { code: null, name: "", message: "" };
  } catch (error) {
    return {
      code: errorCode(error),
      name: error instanceof Error ? error.name : "",
      message: error instanceof Error ? error.message : "",
    };
  }
}

export async function initializeTopology(env: WorkerdEnv) {
  return initialize(durableFor(env, topologyRunId), topologyRunId);
}

export async function recoverTopology(env: WorkerdEnv) {
  return durableFor(env, topologyRunId).filesStore.execute({
    type: "recoverCheckpoint",
    runId: topologyRunId,
    publisher: publisher1,
    checkpointId: checkpointInput.checkpointId,
  });
}

export async function readTopologySupervisor(env: WorkerdEnv) {
  return durableFor(env, topologyRunId).threadSupervisor.execute({
    type: "read",
    runId: topologyRunId,
    control: control1,
  });
}

import type { HarnessDurableState } from "../HarnessDurableState.ts";
import type {
  HarnessProcessHandle,
  HarnessProcessInvocationSettlement,
} from "../HarnessProcessPlacement.ts";
import type { HarnessProcessFacetInvokeInput } from "../HarnessProcessFacet.ts";
import type { HarnessProcessExecutionProcessInput } from "../processPlacement/execution.ts";
import type {
  HarnessProcessResumeCheckpointOutcome,
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeInput,
  HarnessProcessResumeOperationInput,
} from "./contracts.ts";

export interface HarnessProcessResumePreDrainSnapshot {
  readonly lifecycle: string;
  readonly admittedStepId: string | null;
  readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
  readonly nativeSessionId: string;
  readonly generation: number;
  readonly facetNonce: string;
  readonly controlEpoch: number;
  readonly controlIncarnationId: string;
}

export async function persistTerminalEvidence(input: {
  readonly durable: HarnessDurableState;
  readonly transition: HarnessProcessResumeInput;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly previousProcess: HarnessProcessExecutionProcessInput;
  readonly preDrain: HarnessProcessResumePreDrainSnapshot;
  readonly requestId: string | undefined;
  readonly handle: HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
  readonly settlement?: HarnessProcessInvocationSettlement;
  readonly failure?: unknown;
}): Promise<HarnessProcessResumeCheckpointOutcome<HarnessProcessResumeCheckpointReference>> {
  const { durable, transition, operation, previousProcess, preDrain, handle } = input;
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: operation.runId,
    control: transition.nextControl,
  });
  if (
    current.snapshot.lifecycle !== "draining" ||
    current.snapshot.ownerId !== transition.nextControl.ownerId ||
    current.snapshot.controlIncarnationId !== transition.nextControl.incarnationId ||
    current.snapshot.controlEpoch !== transition.nextControl.epoch ||
    current.snapshot.generation !== transition.expectedFacetGeneration ||
    current.currentPublisher.generation !== transition.publisher.generation ||
    current.currentPublisher.facetNonce !== transition.publisher.facetNonce ||
    current.currentPublisher.publisherKey !== transition.publisher.publisherKey ||
    current.snapshot.nativeSessionId !== preDrain.nativeSessionId ||
    preDrain.lifecycle !== "accepting" ||
    preDrain.admittedStepId !== operation.previousStepId ||
    preDrain.generation !== transition.expectedFacetGeneration ||
    previousProcess.processId !== operation.previousProcessId ||
    previousProcess.operationId !== operation.previousOperationId ||
    previousProcess.nativeSessionId !== preDrain.nativeSessionId ||
    previousProcess.expectedFacetGeneration + 1 !== preDrain.generation ||
    previousProcess.checkpointId !== preDrain.checkpoint.checkpointId ||
    previousProcess.manifestRevision !== preDrain.checkpoint.manifestSha256 ||
    handle.identity.incarnationNonce !== preDrain.facetNonce ||
    input.requestId !== operation.previousStepId
  )
    return { _tag: "stale-control" };

  const stopped = await handle.stop();
  const joined = await handle.join();
  const journal = await durable.runStore.execute({ type: "read", runId: operation.runId });
  const request = journal.snapshot.requests?.entries.find(
    (entry) => entry.request.requestId === input.requestId,
  );
  const checkpointCommitted =
    current.snapshot.admittedStepId === null &&
    current.snapshot.checkpoint.checkpointId !== preDrain.checkpoint.checkpointId &&
    request?.status === "completed" &&
    request.finish !== null &&
    current.snapshot.lifecycle === "draining";
  const joinedActual = {
    invocationRpcJoined: joined.invocationRpc,
    fetchJoined: joined.fetch,
    callbackPortsJoined: joined.ports,
  };
  const outcome =
    stopped.acknowledged &&
    joined.invocationRpc &&
    joined.fetch &&
    joined.ports &&
    input.failure === undefined &&
    checkpointCommitted
      ? "stopped"
      : "indeterminate";
  const acknowledgementId = await digest(
    `${transition.operationId}\u0000${handle.identity.incarnationNonce}\u0000stop`,
  );
  if (stopped.acknowledged) {
    await durable.threadSupervisor.execute({
      type: "recordStopAcknowledgement",
      runId: operation.runId,
      control: transition.nextControl,
      publisher: transition.publisher,
      expectedGeneration: transition.expectedFacetGeneration,
      requestId: input.requestId ?? operation.previousOperationId,
      acknowledgementId,
    });
  }
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: operation.runId,
    control: transition.nextControl,
    publisher: transition.publisher,
    expectedGeneration: transition.expectedFacetGeneration,
    outcome,
    ...joinedActual,
  });

  const confirmed = await durable.threadSupervisor.execute({
    type: "read",
    runId: operation.runId,
    control: transition.nextControl,
  });
  if (
    confirmed.snapshot.nativeSessionId !== preDrain.nativeSessionId ||
    confirmed.snapshot.generation !== transition.expectedFacetGeneration ||
    confirmed.snapshot.facetNonce !== transition.publisher.facetNonce ||
    confirmed.currentPublisher.publisherKey !== transition.publisher.publisherKey ||
    confirmed.snapshot.admittedStepId !== null
  )
    return { _tag: "indeterminate" };
  if (
    outcome !== "stopped" ||
    confirmed.snapshot.lifecycle !== "stopped" ||
    confirmed.snapshot.stopAcknowledgementId !== acknowledgementId ||
    confirmed.snapshot.settlement?.outcome !== "stopped" ||
    confirmed.snapshot.settlement.invocationRpcJoined !== true ||
    confirmed.snapshot.settlement.fetchJoined !== true ||
    confirmed.snapshot.settlement.callbackPortsJoined !== true
  )
    return { _tag: "indeterminate" };

  return {
    _tag: "committed",
    checkpoint: {
      checkpointId: confirmed.snapshot.checkpoint.checkpointId,
      manifestSha256: confirmed.snapshot.checkpoint.manifestSha256,
      nativeSessionId: confirmed.snapshot.nativeSessionId,
    },
  };
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `stop-${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

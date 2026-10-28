import type { HarnessProcessCreationInput } from "../processCreation/contracts.ts";
import type { HarnessProcessCreationBinding } from "../processCreation/journal.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import { saveProcessBoundary, type ProcessBoundary } from "./boundary.ts";

export async function saveCreatedProcessBoundary(input: {
  readonly storage: DurableObjectStorage;
  readonly incarnation: ProcessIncarnation;
  readonly creation: HarnessProcessCreationInput;
  readonly binding: HarnessProcessCreationBinding;
}) {
  const { creation, binding } = input;
  const fence = await input.incarnation.assertCurrent();
  const requestPublisher = {
    generation: 1,
    facetNonce: binding.identity.incarnationNonce,
    publisherKey: creation.requestPublisherKey,
  };
  const boundary: ProcessBoundary = {
    version: 1,
    phase: "ready",
    fence,
    runId: creation.runId,
    threadId: creation.run.seed.identity.threadId,
    operationId: creation.operationId,
    callerOperationId: creation.operationId,
    callerPublisher: requestPublisher,
    requestPublisher,
    process: {
      ...creation.facet,
      nativeSessionId: binding.nativeSessionId,
      operationId: creation.operationId,
      checkpointId: binding.checkpoint.native.id,
      manifestRevision: binding.checkpoint.filesystem.sha256,
      priorFacetNonce: binding.identity.incarnationNonce,
      expectedFacetGeneration: 0,
    },
    control: creation.controllerClaim,
    runStore: {
      controlKey: creation.run.controlKey,
      supervisor: {
        epoch: 1,
        claimId: creation.run.claimId,
        supervisorKey: creation.run.supervisorKey,
      },
    },
    prepared: { identity: binding.identity, preparedPublisher: binding.initialization.publisher },
    nativeSessionId: binding.nativeSessionId,
    checkpoint: binding.checkpoint,
    placement: {
      owner: binding.identity.shardOwner,
      executionOperationId: creation.operationId,
      shardOwner: binding.identity.shardOwner,
      shardIndex: 0,
      shardIncarnationNonce: fence.nonce,
    },
  };
  await saveProcessBoundary(input.storage, input.incarnation, boundary);
}

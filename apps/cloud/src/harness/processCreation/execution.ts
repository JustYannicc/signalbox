import { activateCreationJournal } from "./journalActivation.ts";
import { creationInvocationKey } from "./identity.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { OwnedProcessRequest } from "../processResume/executionState.ts";
import { persistTerminalEvidence } from "../processResume/terminalEvidence.ts";
import type {
  HarnessProcessCreationInput,
  HarnessProcessCreationEnvironment,
  HarnessProcessCreationRunInput,
} from "./contracts.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";
import type { HarnessCreatedProcessPlacement } from "./placement.ts";

export async function runCreatedRequest({
  context,
  environment,
  incarnationNonce,
  input,
  binding,
  placement,
  request,
  requestContextId,
  onOwned,
}: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessCreationEnvironment;
  readonly incarnationNonce: string;
  readonly input: HarnessProcessCreationInput;
  readonly binding: HarnessProcessCreationBinding;
  readonly placement: HarnessCreatedProcessPlacement;
  readonly request: HarnessProcessCreationRunInput;
  readonly requestContextId: string;
  readonly onOwned: (owned: OwnedProcessRequest) => void;
}) {
  const durable = createHarnessDurableState(environment, input.runId);
  const checkpoint = binding.checkpoint;
  const publisher = {
    generation: 1,
    facetNonce: binding.identity.incarnationNonce,
    publisherKey: input.requestPublisherKey,
  };
  await activateCreationJournal(environment, input, binding);
  const supervisor = {
    epoch: 1,
    claimId: input.run.claimId,
    supervisorKey: input.run.supervisorKey,
  };
  const key = creationInvocationKey(input.runId);
  const prior = await context.storage.get<unknown>(key);
  if (
    prior !== undefined &&
    (typeof prior !== "object" ||
      prior === null ||
      !("phase" in prior) ||
      prior.phase !== "admitting" ||
      !("request" in prior) ||
      !sameData(prior.request, request))
  )
    throw new Error("The first request already has a durable execution disposition.");
  await context.storage.put(key, { request, phase: "admitting" });
  const offered = await durable.runStore.execute({
    type: "request.offer",
    runId: input.runId,
    supervisor,
    request: request.request,
  });
  const offeredEntry = offered.snapshot.requests?.entries.at(-1);
  if (offeredEntry?.status !== "offered" || !sameData(offeredEntry.request, request.request))
    throw new Error("The first request already has a durable execution disposition.");
  const admitted = await durable.admitStep({
    control: input.controllerClaim,
    stepId: request.request.requestId,
    expectedCheckpointId: checkpoint.native.id,
  });
  if (admitted.status !== "admitted")
    throw new Error("Initial durable request admission is incomplete.");
  const owned: OwnedProcessRequest = {
    kind: "created",
    runId: input.runId,
    durable,
    process: {
      processId: input.facet.processId,
      operationId: input.operationId,
      nativeSessionId: binding.nativeSessionId,
    },
    handle: placement.handle,
    control: input.controllerClaim,
    publisher: binding.initialization.publisher,
    request: request.request,
    runStorePublisher: publisher,
    journal: { controlKey: input.run.controlKey, supervisor },
    parentCheckpoint: checkpoint,
    placement: {
      owner: binding.identity.shardOwner,
      executionOperationId: input.operationId,
      shardOwner: binding.identity.shardOwner,
      shardIndex: 0,
      shardIncarnationNonce: incarnationNonce,
    },
    completion: Promise.withResolvers(),
    settled: Promise.withResolvers(),
    retained: false,
  };
  await context.storage.put(key, { request, phase: "dispatching" });
  onOwned(owned);
  try {
    const settlement = await placement.invoke({
      publisher,
      requestId: request.request.requestId,
    });
    await persistTerminalEvidence({ storage: context.storage, owned, settlement });
    await placement.handle.cleanup();
    await context.storage.put(key, { request, phase: "completed", settlement });
    return {
      requestContextId,
      processes: [
        {
          processId: input.facet.processId,
          requestContextId,
          identity: binding.identity,
          status: "settled" as const,
          settlement,
        },
      ],
    };
  } catch (cause) {
    owned.retained = true;
    throw cause;
  } finally {
    owned.settled.resolve();
  }
}

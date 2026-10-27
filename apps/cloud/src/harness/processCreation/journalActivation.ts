import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type {
  HarnessProcessCreationEnvironment,
  HarnessProcessCreationInput,
} from "./contracts.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";

export async function activateCreationJournal(
  environment: HarnessProcessCreationEnvironment,
  input: HarnessProcessCreationInput,
  binding: HarnessProcessCreationBinding,
) {
  const durable = createHarnessDurableState(environment, input.runId);
  await durable.runStore.execute({
    type: "request.mode",
    runId: input.runId,
    controlKey: input.run.controlKey,
    requestId: input.requestModeId,
    checkpoint: binding.checkpoint,
  });
  await durable.runStore.execute({
    type: "request.replaceFacet",
    runId: input.runId,
    controlKey: input.run.controlKey,
    expectedGeneration: 0,
    operationId: input.operationId,
    facetNonce: binding.identity.incarnationNonce,
    publisherKey: input.requestPublisherKey,
  });
}

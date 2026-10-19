import type {
  HarnessRequestCheckpoint,
  HarnessRequestFinish,
  HarnessRequestPublisher,
  HarnessRunStoreResult,
} from "../../HarnessRunStore.ts";
import { controlKey, fixture, initial, reference, runId, supervisor } from "./fixture.ts";

export const checkpoint = (id: string): HarnessRequestCheckpoint => ({
  native: reference(`${id}-native`),
  filesystem: reference(`${id}-filesystem`),
});
export const mode = {
  type: "request.mode",
  runId,
  controlKey,
  requestId: "request-mode",
  checkpoint: checkpoint("seed"),
};
export const install = (generation = 1) => ({
  type: "request.replaceFacet",
  runId,
  controlKey,
  expectedGeneration: generation - 1,
  operationId: `replace-${generation}`,
  facetNonce: `facet-${generation}`,
  publisherKey: `publisher-for-generation-${generation}-`.repeat(2),
});
export const requestPublisher = (generation = 1): HarnessRequestPublisher => ({
  generation,
  facetNonce: install(generation).facetNonce,
  publisherKey: install(generation).publisherKey,
});
export const offer = (requestId = "step-one") => ({
  type: "request.offer",
  runId,
  supervisor,
  request: { requestId, input: reference(`input-${requestId}`) },
});
export const published = (requestId = "step-one", generation = 1) => ({
  runId,
  requestId,
  publisher: requestPublisher(generation),
});
export const admit = (requestId = "step-one", generation = 1) => ({
  type: "request.admit",
  ...published(requestId, generation),
});
export const check = (requestId = "step-one", generation = 1) => ({
  type: "request.check",
  ...published(requestId, generation),
});
export const requestProgress = (sequence = 1, requestId = "step-one", generation = 1) => ({
  type: "request.progress",
  ...published(requestId, generation),
  progress: { sequence, kind: "native", reference: reference(`progress-${requestId}-${sequence}`) },
});
export const finish = (requestId = "step-one", sequence = 1, generation = 1) => ({
  type: "request.finish",
  ...published(requestId, generation),
  finish: {
    sequence,
    status: "completed",
    result: reference(`result-${requestId}`),
    checkpoint: checkpoint(requestId),
  } satisfies HarnessRequestFinish,
});
export const reconcile = (requestId = "step-one") => ({
  type: "request.reconcile",
  runId,
  controlKey,
  requestId,
  evidence: reference(`reconciliation-${requestId}`),
});
export function entry(result: HarnessRunStoreResult, requestId = "step-one") {
  const row = result.snapshot.requests?.entries.find(
    (entry) => entry.request.requestId === requestId,
  );
  if (!row) throw new Error("Missing request receipt");
  return row;
}
export async function requestFixture() {
  const file = fixture();
  const client = file.open();
  await client.call(initial);
  await client.call(mode);
  await client.call(install());
  return { file, client };
}

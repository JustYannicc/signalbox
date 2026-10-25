import type { OwnedProcessRequest } from "./executionState.ts";
import {
  execute,
  fail,
  sameArtifact,
  sameCheckpoint,
  sameSupervisor,
  sameVisibleState,
} from "./runStoreState.ts";

export async function readCompletedJournal(owned: OwnedProcessRequest) {
  const store = owned.durable.runStore;
  const initial = await execute(store, { type: "read", runId: owned.runId }, "drain");
  const requests = initial.snapshot.requests;
  const entry = requests?.entries.at(-1);
  const facet = requests?.facets.at(-1);
  if (
    requests === undefined ||
    entry === undefined ||
    facet === undefined ||
    !sameSupervisor(initial.snapshot, owned.journal) ||
    entry.request.requestId !== owned.request.requestId ||
    !sameArtifact(entry.request.input, owned.request.input) ||
    entry.status !== "completed" ||
    entry.finish === null ||
    entry.finish.status !== "completed" ||
    entry.generation !== owned.runStorePublisher.generation ||
    entry.facetNonce !== owned.runStorePublisher.facetNonce ||
    facet.generation !== owned.runStorePublisher.generation ||
    facet.facetNonce !== owned.runStorePublisher.facetNonce ||
    facet.operationId !== owned.process.operationId ||
    !sameCheckpoint(requests.checkpoint, entry.finish.checkpoint)
  )
    fail("drain", "request-changed");
  const mode = await execute(
    store,
    {
      type: "request.mode",
      runId: owned.runId,
      controlKey: owned.journal.controlKey,
      requestId: requests.modeId,
      checkpoint: requests.initialCheckpoint,
    },
    "drain",
  );
  if (mode.action !== "unchanged" || !sameVisibleState(initial.snapshot, mode.snapshot))
    fail("drain", "authority-changed");
  const offer = await execute(
    store,
    {
      type: "request.offer",
      runId: owned.runId,
      supervisor: owned.journal.supervisor,
      request: owned.request,
    },
    "drain",
  );
  if (offer.action !== "committed" || !sameVisibleState(initial.snapshot, offer.snapshot))
    fail("drain", "authority-changed");
  const publisher = await execute(
    store,
    {
      type: "request.admit",
      runId: owned.runId,
      publisher: owned.runStorePublisher,
      requestId: owned.request.requestId,
    },
    "drain",
  );
  if (publisher.action !== "committed" || !sameVisibleState(initial.snapshot, publisher.snapshot))
    fail("drain", "publisher-changed");
  return { result: publisher, entry, finish: entry.finish };
}

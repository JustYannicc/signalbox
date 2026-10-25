import type { HarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessRunStoreResult } from "../HarnessRunStore.ts";
import type {
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeOperationInput,
} from "./contracts.ts";
import { snapshotHarnessProcessResumeRunStoreBinding } from "./runStoreBinding.ts";
import {
  assertReplacedFacetSnapshot,
  execute,
  expectedNoOpAction,
  fail,
  matchesOperation,
  sameArtifact,
  sameCheckpoint,
  sameSupervisor,
  sameVisibleState,
  type Published,
} from "./runStoreState.ts";

type RunStoreClient = HarnessDurableState["runStore"];

/** Authenticates the caller's existing independent RunStore capabilities before A starts draining. */
export async function validateHarnessProcessResumeRunStoreStart(input: {
  readonly store: RunStoreClient;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly activeCheckpoint: { readonly checkpointId: string; readonly manifestSha256: string };
}): Promise<HarnessRunStoreResult> {
  const binding = snapshotHarnessProcessResumeRunStoreBinding(input.operation.runStore);
  if (binding === undefined || !matchesOperation(binding, input.operation))
    fail("input", "invalid-input");

  if (
    binding.checkpoint.native.id !== input.activeCheckpoint.checkpointId ||
    binding.checkpoint.filesystem.sha256 !== input.activeCheckpoint.manifestSha256
  )
    fail("preflight", "checkpoint-changed");

  const initial = await execute(input.store, { type: "read", runId: binding.runId }, "preflight");
  const requests = initial.snapshot.requests;
  if (
    requests === undefined ||
    initial.snapshot.seed.identity.runId !== input.operation.runId ||
    !sameSupervisor(initial.snapshot, binding)
  )
    fail("preflight", "request-changed");
  const entry = requests.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const facet = requests.facets.at(-1);
  if (
    entry === undefined ||
    entry !== requests.entries.at(-1) ||
    !sameArtifact(entry.request.input, binding.request.input)
  )
    fail("preflight", "request-changed");
  if (
    facet === undefined ||
    facet.generation !== binding.currentPublisher.generation ||
    facet.facetNonce !== binding.currentPublisher.facetNonce ||
    facet.operationId !== binding.processOperationId ||
    facet.supervisorEpoch !== binding.supervisor.epoch ||
    !sameCheckpoint(facet.checkpoint, binding.checkpoint) ||
    entry.generation !== binding.currentPublisher.generation ||
    entry.facetNonce !== binding.currentPublisher.facetNonce
  )
    fail("preflight", "publisher-changed");
  if (entry.status !== "admitted" && entry.status !== "completed")
    fail("preflight", "request-changed");
  if (
    (entry.status === "admitted" &&
      (entry.finish !== null || !sameCheckpoint(requests.checkpoint, binding.checkpoint))) ||
    (entry.status === "completed" &&
      (entry.finish === null || !sameCheckpoint(entry.finish.checkpoint, requests.checkpoint)))
  )
    fail("preflight", "checkpoint-changed");

  // request.mode is an idempotent control-key check because this mode already exists.
  const mode = await execute(
    input.store,
    {
      type: "request.mode",
      runId: binding.runId,
      controlKey: binding.controlKey,
      requestId: requests.modeId,
      checkpoint: requests.initialCheckpoint,
    },
    "preflight",
  );
  if (mode.action !== "unchanged" || !sameVisibleState(initial.snapshot, mode.snapshot))
    fail("preflight", "request-changed");

  const offer = await execute(
    input.store,
    {
      type: "request.offer",
      runId: binding.runId,
      supervisor: binding.supervisor,
      request: binding.request,
    },
    "preflight",
  );
  if (
    offer.action !== expectedNoOpAction(entry) ||
    !sameVisibleState(initial.snapshot, offer.snapshot)
  )
    fail("preflight", "request-changed");

  const publisher = await execute(
    input.store,
    {
      type: "request.admit",
      runId: binding.runId,
      requestId: binding.request.requestId,
      publisher: binding.currentPublisher,
    },
    "preflight",
  );
  if (
    publisher.action !== expectedNoOpAction(entry) ||
    !sameVisibleState(initial.snapshot, publisher.snapshot)
  )
    fail("preflight", "request-changed");
  return publisher;
}

/** Re-reads and authenticates the completed request after the old process has fully drained. */
export async function validateHarnessProcessResumeRunStoreDrain(input: {
  readonly store: RunStoreClient;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly checkpoint: HarnessProcessResumeCheckpointReference;
}): Promise<HarnessRunStoreResult> {
  const binding = snapshotHarnessProcessResumeRunStoreBinding(input.operation.runStore);
  if (binding === undefined || !matchesOperation(binding, input.operation))
    fail("drain", "invalid-input");

  const initial = await execute(input.store, { type: "read", runId: binding.runId }, "drain");
  if (
    !sameSupervisor(initial.snapshot, binding) ||
    initial.snapshot.seed.identity.runId !== input.operation.runId
  )
    fail("drain", "authority-changed");
  const requests = initial.snapshot.requests;
  if (requests === undefined) fail("drain", "request-changed");
  const entry = requests.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const facet = requests.facets.at(-1);
  if (
    entry === undefined ||
    entry !== requests.entries.at(-1) ||
    entry.status !== "completed" ||
    entry.finish === null ||
    entry.generation !== binding.currentPublisher.generation ||
    entry.facetNonce !== binding.currentPublisher.facetNonce ||
    !sameArtifact(entry.request.input, binding.request.input)
  )
    fail("drain", "request-changed");
  if (
    facet === undefined ||
    facet.generation !== binding.currentPublisher.generation ||
    facet.facetNonce !== binding.currentPublisher.facetNonce ||
    facet.operationId !== binding.processOperationId ||
    facet.supervisorEpoch !== binding.supervisor.epoch ||
    !sameCheckpoint(facet.checkpoint, binding.checkpoint)
  )
    fail("drain", "publisher-changed");
  const checkpoint = entry.finish.checkpoint;
  if (
    !sameCheckpoint(requests.checkpoint, checkpoint) ||
    checkpoint.native.id !== input.checkpoint.checkpointId ||
    checkpoint.filesystem.sha256 !== input.checkpoint.manifestSha256
  )
    fail("drain", "checkpoint-changed");

  const mode = await execute(
    input.store,
    {
      type: "request.mode",
      runId: binding.runId,
      controlKey: binding.controlKey,
      requestId: requests.modeId,
      checkpoint: requests.initialCheckpoint,
    },
    "drain",
  );
  if (mode.action !== "unchanged" || !sameVisibleState(initial.snapshot, mode.snapshot))
    fail("drain", "request-changed");

  const offer = await execute(
    input.store,
    {
      type: "request.offer",
      runId: binding.runId,
      supervisor: binding.supervisor,
      request: binding.request,
    },
    "drain",
  );
  if (offer.action !== "committed" || !sameVisibleState(initial.snapshot, offer.snapshot))
    fail("drain", "request-changed");

  const publisher = await execute(
    input.store,
    {
      type: "request.admit",
      runId: binding.runId,
      requestId: binding.request.requestId,
      publisher: binding.currentPublisher,
    },
    "drain",
  );
  if (publisher.action !== "committed" || !sameVisibleState(initial.snapshot, publisher.snapshot))
    fail("drain", "request-changed");
  return publisher;
}

/** Reauthenticates an already published replacement before returning cached resume success. */
export async function validateHarnessProcessResumeRunStoreActive(input: {
  readonly store: RunStoreClient;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly checkpoint: HarnessProcessResumeCheckpointReference;
  readonly preparedFacetNonce: string;
}): Promise<HarnessRunStoreResult> {
  const binding = snapshotHarnessProcessResumeRunStoreBinding(input.operation.runStore);
  if (binding === undefined || !matchesOperation(binding, input.operation))
    fail("replacement", "invalid-input");

  const initial = await execute(input.store, { type: "read", runId: binding.runId }, "replacement");
  const requests = initial.snapshot.requests;
  const entry = requests?.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const facet = requests?.facets.at(-1);
  if (
    requests === undefined ||
    entry === undefined ||
    entry !== requests.entries.at(-1) ||
    entry.status !== "completed" ||
    entry.finish === null ||
    !sameArtifact(entry.request.input, binding.request.input) ||
    entry.generation !== binding.currentPublisher.generation ||
    entry.facetNonce !== binding.currentPublisher.facetNonce ||
    facet === undefined ||
    facet.operationId !== binding.transitionOperationId ||
    facet.generation !== binding.currentPublisher.generation + 1 ||
    facet.facetNonce !== input.preparedFacetNonce ||
    facet.supervisorEpoch !== binding.supervisor.epoch ||
    facet.checkpoint.native.id !== input.checkpoint.checkpointId ||
    facet.checkpoint.filesystem.sha256 !== input.checkpoint.manifestSha256 ||
    requests.checkpoint.native.id !== input.checkpoint.checkpointId ||
    requests.checkpoint.filesystem.sha256 !== input.checkpoint.manifestSha256 ||
    !sameCheckpoint(entry.finish.checkpoint, requests.checkpoint) ||
    initial.snapshot.seed.identity.runId !== binding.runId ||
    !sameSupervisor(initial.snapshot, binding)
  )
    fail("replacement", "request-changed");

  const replaced = await execute(
    input.store,
    {
      type: "request.replaceFacet",
      runId: binding.runId,
      controlKey: binding.controlKey,
      expectedGeneration: binding.currentPublisher.generation,
      operationId: binding.transitionOperationId,
      facetNonce: input.preparedFacetNonce,
      publisherKey: binding.nextPublisherKey,
    },
    "replacement",
  );
  if (replaced.action !== "unchanged" || !sameVisibleState(initial.snapshot, replaced.snapshot))
    fail("replacement", "authority-changed");
  const offered = await execute(
    input.store,
    {
      type: "request.offer",
      runId: binding.runId,
      supervisor: binding.supervisor,
      request: binding.request,
    },
    "replacement",
  );
  if (offered.action !== "committed" || !sameVisibleState(initial.snapshot, offered.snapshot))
    fail("replacement", "request-changed");
  return offered;
}

/** Replaces the RunStore publisher with a real journal command after A's confirmed publication. */
export async function replaceHarnessProcessResumeRunStoreFacet(input: {
  readonly store: RunStoreClient;
  readonly operation: HarnessProcessResumeOperationInput;
  readonly expectedJournal: HarnessRunStoreResult;
  readonly checkpoint: HarnessProcessResumeCheckpointReference;
  readonly preparedFacetNonce: string;
  readonly publication: Published;
}): Promise<HarnessRunStoreResult> {
  const binding = snapshotHarnessProcessResumeRunStoreBinding(input.operation.runStore);
  if (binding === undefined || !matchesOperation(binding, input.operation))
    fail("replacement", "invalid-input");

  const receipt = input.publication.receipt;
  if (
    input.publication.control.ownerId !== input.operation.transition.nextControl.ownerId ||
    input.publication.control.incarnationId !==
      input.operation.transition.nextControl.incarnationId ||
    input.publication.control.epoch !== input.operation.transition.nextControl.epoch ||
    input.publication.control.controlKey !== input.operation.transition.nextControl.controlKey ||
    receipt.status !== "confirmed" ||
    receipt.operationId !== binding.transitionOperationId ||
    receipt.fromGeneration !== binding.currentPublisher.generation ||
    receipt.toGeneration !== binding.currentPublisher.generation + 1 ||
    receipt.priorFacetNonce !== binding.currentPublisher.facetNonce ||
    receipt.preparedFacetNonce !== input.preparedFacetNonce ||
    receipt.checkpoint.checkpointId !== input.checkpoint.checkpointId ||
    receipt.checkpoint.manifestSha256 !== input.checkpoint.manifestSha256
  )
    fail("replacement", "checkpoint-changed");

  const expectedSnapshot = input.expectedJournal.snapshot;
  const expectedRequests = expectedSnapshot.requests;
  const expectedEntry = expectedRequests?.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const expectedFacet = expectedRequests?.facets.at(-1);
  if (
    expectedRequests === undefined ||
    expectedEntry === undefined ||
    expectedFacet === undefined ||
    expectedEntry !== expectedRequests.entries.at(-1) ||
    expectedEntry.status !== "completed" ||
    expectedEntry.finish === null ||
    expectedEntry.generation !== binding.currentPublisher.generation ||
    expectedEntry.facetNonce !== binding.currentPublisher.facetNonce ||
    !sameArtifact(expectedEntry.request.input, binding.request.input) ||
    expectedFacet.generation !== binding.currentPublisher.generation ||
    expectedFacet.facetNonce !== binding.currentPublisher.facetNonce ||
    expectedFacet.operationId !== binding.processOperationId ||
    expectedFacet.supervisorEpoch !== binding.supervisor.epoch ||
    !sameCheckpoint(expectedFacet.checkpoint, binding.checkpoint) ||
    expectedSnapshot.seed.identity.runId !== binding.runId ||
    !sameSupervisor(expectedSnapshot, binding) ||
    !sameCheckpoint(expectedRequests.checkpoint, expectedEntry.finish.checkpoint) ||
    expectedRequests.checkpoint.native.id !== input.checkpoint.checkpointId ||
    expectedRequests.checkpoint.filesystem.sha256 !== input.checkpoint.manifestSha256
  )
    fail("replacement", "request-changed");

  const replacement = await execute(
    input.store,
    {
      type: "request.replaceFacet",
      runId: binding.runId,
      controlKey: binding.controlKey,
      expectedGeneration: receipt.fromGeneration,
      operationId: receipt.operationId,
      facetNonce: receipt.preparedFacetNonce,
      publisherKey: binding.nextPublisherKey,
    },
    "replacement",
  );
  if (replacement.action !== "recorded" && replacement.action !== "unchanged")
    fail("replacement", "request-changed");
  assertReplacedFacetSnapshot(
    replacement.snapshot,
    expectedSnapshot,
    binding,
    input.checkpoint,
    receipt,
  );

  // The same exact request no-ops, while checking that the caller's supervisor claim is still current.
  const offer = await execute(
    input.store,
    {
      type: "request.offer",
      runId: binding.runId,
      supervisor: binding.supervisor,
      request: binding.request,
    },
    "replacement",
  );
  if (offer.action !== "committed") fail("replacement", "authority-changed");
  if (!sameVisibleState(replacement.snapshot, offer.snapshot))
    fail("replacement", "request-changed");
  return offer;
}

import type {
  HarnessDurableState,
  HarnessDurableStatePublicationResult,
} from "../HarnessDurableState.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestFinish,
  HarnessRequestOffer,
  HarnessRequestReconciliation,
  HarnessRunStoreCommand,
  HarnessRunStoreResult,
} from "../HarnessRunStore.ts";
import type {
  HarnessProcessResumeOperationInput,
  HarnessProcessResumeRunStoreBinding,
} from "./contracts.ts";
import { HarnessProcessResumeRunStoreError } from "./errors.ts";

export type RunStoreClient = HarnessDurableState["runStore"];
export type Snapshot = HarnessRunStoreResult["snapshot"];
export type Requests = NonNullable<Snapshot["requests"]>;
export type Entry = Requests["entries"][number];
type RequestFacet = Requests["facets"][number];
export type RunStoreFailureStage = "input" | "preflight" | "drain" | "replacement";
export type RunStoreFailureReason =
  | "invalid-input"
  | "authority-changed"
  | "publisher-changed"
  | "request-changed"
  | "checkpoint-changed"
  | "unknown";
export type Published = Extract<
  HarnessDurableStatePublicationResult,
  { readonly status: "published" }
>;

export function fail(stage: RunStoreFailureStage, reason: RunStoreFailureReason): never {
  throw new HarnessProcessResumeRunStoreError({ stage, reason });
}

export const sameArtifact = (
  left: { readonly id: string; readonly sha256: string; readonly bytes: number },
  right: { readonly id: string; readonly sha256: string; readonly bytes: number },
) => left.id === right.id && left.sha256 === right.sha256 && left.bytes === right.bytes;

export const sameCheckpoint = (left: HarnessRequestCheckpoint, right: HarnessRequestCheckpoint) =>
  sameArtifact(left.native, right.native) && sameArtifact(left.filesystem, right.filesystem);

export const sameSupervisor = (snapshot: Snapshot, binding: HarnessProcessResumeRunStoreBinding) =>
  snapshot.supervisor.epoch === binding.supervisor.epoch &&
  snapshot.supervisor.claimId === binding.supervisor.claimId;

export const matchesOperation = (
  binding: HarnessProcessResumeRunStoreBinding,
  operation: HarnessProcessResumeOperationInput,
) => {
  const transition = operation.transition;
  const runStoreKeys = [
    binding.controlKey,
    binding.supervisor.supervisorKey,
    binding.currentPublisher.publisherKey,
    binding.nextPublisherKey,
  ];
  return (
    binding.runId === operation.runId &&
    binding.processId === operation.previousProcessId &&
    binding.processOperationId === operation.previousOperationId &&
    binding.transitionOperationId === transition.operationId &&
    binding.request.requestId === operation.previousStepId &&
    binding.currentPublisher.generation === transition.expectedFacetGeneration &&
    binding.currentPublisher.generation === transition.publisher.generation &&
    binding.currentPublisher.facetNonce === transition.publisher.facetNonce &&
    binding.controlKey !== transition.control.controlKey &&
    binding.controlKey !== transition.nextControl.controlKey &&
    binding.supervisor.supervisorKey !== transition.control.controlKey &&
    binding.supervisor.supervisorKey !== transition.nextControl.controlKey &&
    binding.nextPublisherKey !== transition.control.controlKey &&
    binding.nextPublisherKey !== transition.nextControl.controlKey &&
    new Set(runStoreKeys).size === runStoreKeys.length
  );
};

export function commandError(
  error: unknown,
  stage: RunStoreFailureStage,
): HarnessProcessResumeRunStoreError {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const reason: RunStoreFailureReason =
    code === "STALE_SUPERVISOR"
      ? "authority-changed"
      : code === "PUBLISHER_DENIED"
        ? "publisher-changed"
        : code === "CONFLICT" || code === "MISSING"
          ? "request-changed"
          : "unknown";
  return new HarnessProcessResumeRunStoreError({ stage, reason });
}

export async function execute(
  store: RunStoreClient,
  command: HarnessRunStoreCommand,
  stage: RunStoreFailureStage,
): Promise<HarnessRunStoreResult> {
  try {
    return await store.execute(command);
  } catch (error) {
    throw commandError(error, stage);
  }
}

export const sameVisibleState = (left: Snapshot, right: Snapshot) =>
  left.version === right.version &&
  left.seed.identity.runId === right.seed.identity.runId &&
  left.seed.identity.hostId === right.seed.identity.hostId &&
  left.seed.identity.threadId === right.seed.identity.threadId &&
  left.seed.identity.logicalTurnId === right.seed.identity.logicalTurnId &&
  left.seed.identity.filesystemId === right.seed.identity.filesystemId &&
  sameArtifact(left.seed.locator, right.seed.locator) &&
  sameArtifact(left.seed.config, right.seed.config) &&
  sameArtifacts(left.seed.artifacts, right.seed.artifacts) &&
  left.supervisor.epoch === right.supervisor.epoch &&
  left.supervisor.claimId === right.supervisor.claimId &&
  left.supervisor.requestId === right.supervisor.requestId &&
  left.supervisor.expectedEpoch === right.supervisor.expectedEpoch &&
  sameInvocation(left.invocation, right.invocation) &&
  sameProgress(left.progress, right.progress) &&
  sameTerminal(left.terminal, right.terminal) &&
  sameReceipts(left.receipts, right.receipts) &&
  sameIntents(left.intents, right.intents) &&
  sameRequests(left.requests, right.requests);

export const expectedNoOpAction = (entry: Entry): HarnessRunStoreResult["action"] =>
  entry.status === "completed" ? "committed" : "observe-only";

export function assertReplacedFacetSnapshot(
  snapshot: Snapshot,
  expected: Snapshot,
  binding: HarnessProcessResumeRunStoreBinding,
  checkpoint: { readonly checkpointId: string; readonly manifestSha256: string },
  receipt: Published["receipt"],
) {
  if (!sameSupervisor(snapshot, binding)) fail("replacement", "authority-changed");
  const requests = snapshot.requests;
  const expectedRequests = expected.requests;
  const entry = requests?.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const expectedEntry = expectedRequests?.entries.find(
    (candidate) => candidate.request.requestId === binding.request.requestId,
  );
  const facet = requests?.facets.at(-1);
  if (
    requests === undefined ||
    expectedRequests === undefined ||
    entry === undefined ||
    expectedEntry === undefined ||
    entry !== requests.entries.at(-1) ||
    expectedEntry !== expectedRequests.entries.at(-1) ||
    expectedEntry.status !== "completed" ||
    expectedEntry.finish === null ||
    entry.status !== "completed" ||
    entry.finish === null ||
    !sameArtifact(entry.request.input, binding.request.input) ||
    entry.generation !== binding.currentPublisher.generation ||
    entry.facetNonce !== binding.currentPublisher.facetNonce ||
    !sameEntry(entry, expectedEntry)
  )
    fail("replacement", "request-changed");
  if (
    facet === undefined ||
    facet.operationId !== receipt.operationId ||
    facet.generation !== receipt.toGeneration ||
    facet.facetNonce !== receipt.preparedFacetNonce ||
    facet.supervisorEpoch !== binding.supervisor.epoch
  )
    fail("replacement", "publisher-changed");
  if (
    requests.modeId !== expectedRequests.modeId ||
    !sameCheckpoint(requests.initialCheckpoint, expectedRequests.initialCheckpoint) ||
    requests.entries.length !== expectedRequests.entries.length ||
    !sameEntries(requests.entries, expectedRequests.entries) ||
    requests.facets.length !== expectedRequests.facets.length + 1 ||
    !sameFacets(requests.facets.slice(0, -1), expectedRequests.facets) ||
    !sameCheckpoint(requests.checkpoint, entry.finish.checkpoint) ||
    !sameCheckpoint(requests.checkpoint, expectedRequests.checkpoint) ||
    !sameCheckpoint(facet.checkpoint, requests.checkpoint) ||
    requests.checkpoint.native.id !== checkpoint.checkpointId ||
    requests.checkpoint.filesystem.sha256 !== checkpoint.manifestSha256 ||
    entry.finish.checkpoint.native.id !== checkpoint.checkpointId ||
    entry.finish.checkpoint.filesystem.sha256 !== checkpoint.manifestSha256
  )
    fail("replacement", "checkpoint-changed");
}

const sameArtifacts = (
  left: ReadonlyArray<{ readonly id: string; readonly sha256: string; readonly bytes: number }>,
  right: ReadonlyArray<{ readonly id: string; readonly sha256: string; readonly bytes: number }>,
) => left.length === right.length && left.every((item, index) => sameArtifact(item, right[index]!));

function sameOffer(left: HarnessRequestOffer, right: HarnessRequestOffer) {
  return left.requestId === right.requestId && sameArtifact(left.input, right.input);
}

function sameFinish(left: HarnessRequestFinish | null, right: HarnessRequestFinish | null) {
  return left === null
    ? right === null
    : right !== null &&
        left.sequence === right.sequence &&
        left.status === right.status &&
        sameArtifact(left.result, right.result) &&
        sameCheckpoint(left.checkpoint, right.checkpoint);
}

function sameProgress(left: Snapshot["progress"], right: Snapshot["progress"]) {
  return left === null
    ? right === null
    : right !== null &&
        left.sequence === right.sequence &&
        left.kind === right.kind &&
        sameArtifact(left.reference, right.reference);
}

function sameTerminal(left: Snapshot["terminal"], right: Snapshot["terminal"]) {
  return left === null
    ? right === null
    : right !== null &&
        left.sequence === right.sequence &&
        left.status === right.status &&
        sameArtifact(left.reference, right.reference);
}

function sameInvocation(left: Snapshot["invocation"], right: Snapshot["invocation"]) {
  if (left === null) return right === null;
  return (
    right !== null &&
    left.declaredEpoch === right.declaredEpoch &&
    left.retired === right.retired &&
    left.declaration.invocationId === right.declaration.invocationId &&
    left.declaration.nativeIncarnationId === right.declaration.nativeIncarnationId &&
    left.declaration.requestId === right.declaration.requestId &&
    sameArtifact(left.declaration.locator, right.declaration.locator)
  );
}

function sameReceipts(left: Snapshot["receipts"], right: Snapshot["receipts"]) {
  return (
    left.length === right.length &&
    left.every((receipt, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        receipt.receiptId === other.receiptId &&
        receipt.kind === other.kind &&
        receipt.epoch === other.epoch &&
        sameArtifact(receipt.subject, other.subject) &&
        sameArtifact(receipt.evidence, other.evidence)
      );
    })
  );
}

function sameIntents(left: Snapshot["intents"], right: Snapshot["intents"]) {
  return (
    left.length === right.length &&
    left.every((intent, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        intent.intentId === other.intentId &&
        intent.kind === other.kind &&
        intent.epoch === other.epoch &&
        intent.claimId === other.claimId &&
        (intent.reference === null
          ? other.reference === null
          : other.reference !== null && sameArtifact(intent.reference, other.reference))
      );
    })
  );
}

function sameRequests(left: Snapshot["requests"], right: Snapshot["requests"]) {
  if (left === undefined) return right === undefined;
  return (
    right !== undefined &&
    left.modeId === right.modeId &&
    sameCheckpoint(left.initialCheckpoint, right.initialCheckpoint) &&
    sameCheckpoint(left.checkpoint, right.checkpoint) &&
    sameFacets(left.facets, right.facets) &&
    sameEntries(left.entries, right.entries)
  );
}

function sameFacets(left: ReadonlyArray<RequestFacet>, right: ReadonlyArray<RequestFacet>) {
  return (
    left.length === right.length &&
    left.every((facet, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        facet.generation === other.generation &&
        facet.operationId === other.operationId &&
        facet.facetNonce === other.facetNonce &&
        facet.supervisorEpoch === other.supervisorEpoch &&
        sameCheckpoint(facet.checkpoint, other.checkpoint)
      );
    })
  );
}

function sameEntries(left: ReadonlyArray<Entry>, right: ReadonlyArray<Entry>) {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && sameEntry(entry, other);
    })
  );
}

function sameEntry(left: Entry, right: Entry) {
  return (
    sameOffer(left.request, right.request) &&
    left.generation === right.generation &&
    left.facetNonce === right.facetNonce &&
    left.status === right.status &&
    left.progress?.sequence === right.progress?.sequence &&
    left.progress?.kind === right.progress?.kind &&
    (left.progress === null
      ? right.progress === null
      : right.progress !== null &&
        sameArtifact(left.progress.reference, right.progress.reference)) &&
    sameFinish(left.finish, right.finish) &&
    sameReconciliation(left.reconciliation, right.reconciliation)
  );
}

function sameReconciliation(
  left: HarnessRequestReconciliation | null,
  right: HarnessRequestReconciliation | null,
) {
  if (left === null) return right === null;
  if (right === null || !sameArtifact(left.evidence, right.evidence)) return false;
  if (left.outcome.type !== right.outcome.type) return false;
  if (left.outcome.type === "unknown" || left.outcome.type === "not-applied") return true;
  return (
    right.outcome.type === "completed" &&
    left.outcome.status === right.outcome.status &&
    sameArtifact(left.outcome.result, right.outcome.result) &&
    sameCheckpoint(left.outcome.checkpoint, right.outcome.checkpoint)
  );
}

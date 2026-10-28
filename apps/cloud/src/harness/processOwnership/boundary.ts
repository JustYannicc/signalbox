import type {
  HarnessRequestCheckpoint,
  HarnessRequestOffer,
  HarnessRequestPublisher,
} from "../HarnessRunStore.ts";
import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import type { ResumedProcess } from "../processResume/resumeAttempt.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import { readProcessFence, sameProcessFence, fenceHistoryKey, type ProcessFence } from "./fence.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { sameControl, samePublisher, sameReference } from "../processResume/authority.ts";
import type { HarnessDurableState } from "../HarnessDurableState.ts";
import { activeKey, readOwned, ownedRequestKey, type DurableOwnedRequest } from "./ownedRequest.ts";

export interface ProcessBoundary extends Omit<ResumedProcess, "prepared" | "publication"> {
  readonly version: 1;
  readonly phase: "ready" | "idle" | "executing" | "restoring" | "retained" | "stopped";
  readonly fence: ProcessFence;
  readonly threadId: string;
  readonly callerOperationId: string;
  readonly callerPublisher: HarnessRequestPublisher;
  readonly publication?: ResumedProcess["publication"];
  readonly prepared: Pick<ResumedProcess["prepared"], "identity" | "preparedPublisher">;
  readonly lastRequest?: {
    readonly request: HarnessRequestOffer;
    readonly ownedKey: string;
    readonly settlement: HarnessProcessInvocationSettlement;
  };
}

export const processBoundaryKey = (runId: string) =>
  `harness-process-boundary/v1/${encodeURIComponent(runId)}`;

export async function readProcessBoundary(storage: DurableObjectStorage, runId: string) {
  const record = await storage.get<ProcessBoundary>(processBoundaryKey(runId));
  if (record === undefined) return undefined;
  if (
    record.version !== 1 ||
    record.runId !== runId ||
    !["ready", "idle", "executing", "restoring", "retained", "stopped"].includes(record.phase) ||
    !record.callerOperationId ||
    !record.threadId ||
    record.prepared.identity.shardOwner !== record.placement.owner ||
    record.prepared.identity.facetKey !== record.prepared.identity.loaderId ||
    record.prepared.identity.incarnationNonce !== record.requestPublisher.facetNonce ||
    record.prepared.preparedPublisher.facetNonce !== record.requestPublisher.facetNonce ||
    record.prepared.preparedPublisher.generation !== record.requestPublisher.generation ||
    record.placement.shardIncarnationNonce !== record.fence.nonce ||
    record.placement.owner !== record.fence.owner ||
    !sameControl(record.control, record.publication?.control ?? record.control)
  )
    throw new Error("The durable process boundary is malformed.");
  readProcessFence(record.fence);
  return record;
}

export async function saveProcessBoundary(
  storage: DurableObjectStorage,
  incarnation: ProcessIncarnation,
  record: ProcessBoundary,
) {
  const fence = await incarnation.assertCurrent();
  if (!sameProcessFence(record.fence, fence))
    throw new Error("A process boundary must belong to its current shard incarnation.");
  await storage.put(processBoundaryKey(record.runId), structuredClone(record));
}

export async function boundaryFromResumed(
  storage: DurableObjectStorage,
  incarnation: ProcessIncarnation,
  resumed: ResumedProcess,
  durable: HarnessDurableState,
) {
  const journal = await durable.runStore.execute({ type: "read", runId: resumed.runId });
  const boundary: ProcessBoundary = {
    ...resumed,
    version: 1,
    phase: "ready",
    fence: await incarnation.assertCurrent(),
    threadId: journal.snapshot.seed.identity.threadId,
    callerOperationId: resumed.operationId,
    callerPublisher: resumed.requestPublisher,
    prepared: {
      identity: {
        shardOwner: resumed.prepared.identity.shardOwner,
        loaderId: resumed.prepared.identity.loaderId,
        facetKey: resumed.prepared.identity.facetKey,
        incarnationNonce: resumed.prepared.identity.incarnationNonce,
      },
      preparedPublisher: resumed.prepared.preparedPublisher,
    },
  };
  await saveProcessBoundary(storage, incarnation, boundary);
  return boundary;
}

export function assertBoundaryCaller(
  boundary: ProcessBoundary,
  input: {
    readonly runId: string;
    readonly processId: string;
    readonly executionOperationId: string;
    readonly resumeOperationId: string;
    readonly control: ProcessBoundary["control"];
    readonly runStore: ProcessBoundary["runStore"] & {
      readonly currentPublisher: HarnessRequestPublisher;
      readonly checkpoint: HarnessRequestCheckpoint;
    };
  },
) {
  if (
    input.runId !== boundary.runId ||
    input.processId !== boundary.process.processId ||
    input.executionOperationId !== boundary.placement.executionOperationId ||
    input.resumeOperationId !== boundary.callerOperationId ||
    !sameControl(input.control, boundary.control) ||
    input.runStore.controlKey !== boundary.runStore.controlKey ||
    !sameData(input.runStore.supervisor, boundary.runStore.supervisor) ||
    (!samePublisher(input.runStore.currentPublisher, boundary.callerPublisher) &&
      !samePublisher(input.runStore.currentPublisher, boundary.requestPublisher)) ||
    !sameData(input.runStore.checkpoint, boundary.checkpoint)
  )
    throw new Error("The request does not match its durable process boundary.");
}

/** Prove an idle, committed source before retiring its destroyed parent or opening another B. */
export async function validateProcessBoundary(input: {
  readonly storage: DurableObjectStorage;
  readonly incarnation: ProcessIncarnation;
  readonly boundary: ProcessBoundary;
  readonly durable: HarnessDurableState;
}) {
  const { boundary, storage, incarnation, durable } = input;
  const currentFence = await incarnation.assertCurrent();
  const history = await storage.get<ProcessFence>(fenceHistoryKey(boundary.fence.incarnation));
  if (
    history === undefined ||
    !sameProcessFence(readProcessFence(history), boundary.fence) ||
    boundary.fence.owner !== currentFence.owner ||
    boundary.fence.incarnation > currentFence.incarnation ||
    (boundary.phase !== "ready" && boundary.phase !== "idle")
  )
    throw new Error("The process boundary is uncertain or belongs to another incarnation.");
  const journal = await durable.runStore.execute({ type: "read", runId: boundary.runId });
  const requests = journal.snapshot.requests;
  const facet = requests?.facets.at(-1);
  if (
    !requests ||
    !facet ||
    facet.operationId !== boundary.process.operationId ||
    facet.generation !== boundary.requestPublisher.generation ||
    facet.facetNonce !== boundary.requestPublisher.facetNonce ||
    facet.supervisorEpoch !== boundary.runStore.supervisor.epoch ||
    journal.snapshot.supervisor.epoch !== boundary.runStore.supervisor.epoch ||
    journal.snapshot.supervisor.claimId !== boundary.runStore.supervisor.claimId ||
    !sameData(requests.checkpoint, boundary.checkpoint) ||
    requests.entries.some(
      (entry) => !["completed", "not-applied", "withdrawn"].includes(entry.status),
    )
  )
    throw new Error("The process boundary no longer matches the committed request journal.");
  // Recheck the caller's control-key and supervisor capabilities without changing the journal.
  const checked = await durable.runStore.execute({
    type: "request.replaceFacet",
    runId: boundary.runId,
    controlKey: boundary.runStore.controlKey,
    expectedGeneration: facet.generation - 1,
    operationId: facet.operationId,
    facetNonce: facet.facetNonce,
    publisherKey: boundary.requestPublisher.publisherKey,
  });
  if (checked.action !== "unchanged" || !sameData(checked.snapshot, journal.snapshot))
    throw new Error("The process journal authority changed.");
  let owned: DurableOwnedRequest | undefined;
  if (boundary.phase === "idle") {
    const last = boundary.lastRequest;
    const entry = requests.entries.at(-1);
    if (
      !last ||
      !entry ||
      entry.status !== "completed" ||
      !entry.finish ||
      !sameData(entry.request, last.request) ||
      !sameData(entry.finish.checkpoint, boundary.checkpoint) ||
      (await storage.get(activeKey(boundary.runId))) !== last.ownedKey
    )
      throw new Error("The idle boundary has no exact completed owned request.");
    owned = readOwned(await storage.get(last.ownedKey));
    const completion = await storage.get<{
      readonly phase: string;
      readonly result?: { readonly status: string };
    }>(
      `harness-process-completion/v1/${encodeURIComponent(boundary.runId)}/${encodeURIComponent(owned.process.operationId)}/${encodeURIComponent(last.request.requestId)}`,
    );
    const continuation = await storage.get<{
      readonly phase: string;
      readonly checkpoint?: HarnessRequestCheckpoint;
    }>(
      `harness-process-continuation/v1/${encodeURIComponent(boundary.runId)}/${encodeURIComponent(last.request.requestId)}`,
    );
    if (
      owned.retained ||
      owned.terminalKey !== undefined ||
      owned.resumeClaim !== undefined ||
      !sameProcessFence(owned.fence, boundary.fence) ||
      !sameData(owned.identity, boundary.prepared.identity) ||
      !sameData(owned.placement, boundary.placement) ||
      !sameControl(owned.control, boundary.control) ||
      !samePublisher(owned.publisher, boundary.prepared.preparedPublisher) ||
      !samePublisher(owned.runStorePublisher, boundary.requestPublisher) ||
      !sameData(owned.request, last.request) ||
      last.ownedKey !==
        ownedRequestKey(boundary.runId, owned.process.operationId, last.request.requestId) ||
      completion?.phase !== "committed" ||
      completion.result?.status !== "committed" ||
      continuation?.phase !== "idle" ||
      !sameData(continuation.checkpoint, boundary.checkpoint) ||
      last.settlement.processRetained !== true ||
      !last.settlement.joined.invocationRpc
    )
      throw new Error(
        "The idle boundary is missing its exact durable completion and ownership chain.",
      );
  }
  const files = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId: boundary.runId,
    publisher: boundary.prepared.preparedPublisher,
    checkpointId: boundary.checkpoint.native.id,
  });
  if (
    files.checkpoint.manifestSha256 !== boundary.checkpoint.filesystem.sha256 ||
    files.checkpoint.checkpointId !== boundary.checkpoint.native.id
  )
    throw new Error("The idle checkpoint bytes are not available.");
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId: boundary.runId,
    control: boundary.control,
  });
  if (
    supervisor.snapshot.lifecycle !== "accepting" ||
    supervisor.snapshot.admittedStepId !== null ||
    supervisor.snapshot.nativeSessionId !== boundary.nativeSessionId ||
    !samePublisher(supervisor.currentPublisher, boundary.prepared.preparedPublisher) ||
    !sameReference(supervisor.snapshot.checkpoint, {
      checkpointId: boundary.checkpoint.native.id,
      manifestSha256: boundary.checkpoint.filesystem.sha256,
    }) ||
    (boundary.publication !== undefined &&
      supervisor.snapshot.lastPublicationOperationId !== boundary.process.operationId)
  )
    throw new Error("The process boundary no longer has current thread authority.");
  await incarnation.assertCurrent();
  return { currentFence, journal, owned };
}

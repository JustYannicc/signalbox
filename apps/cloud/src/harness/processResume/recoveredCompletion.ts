import type {
  HarnessDurableState,
  HarnessDurableStateCheckpointResult,
} from "../HarnessDurableState.ts";
import { prepareCheckpoint } from "../durableState/files/content.ts";
import {
  activeKey,
  ownedRequestKey,
  readOwned,
  type DurableOwnedRequest,
} from "../processOwnership/ownedRequest.ts";
import {
  fenceHistoryKey,
  localFenceKey,
  readProcessFence,
  sameProcessFence,
  type ProcessFence,
} from "../processOwnership/fence.ts";
import type { HarnessRunSnapshot } from "../HarnessRunStore.ts";
import { sameControl, samePublisher, sameReference } from "./authority.ts";
import { sameData, type HarnessProcessCheckpointInput } from "./checkpointContract.ts";
import type { ProcessTerminalEvidence } from "./terminalContract.ts";
import { terminalKey } from "./terminalContract.ts";
import { sameCheckpoint } from "./runStoreState.ts";

export interface CompletionRecord {
  readonly input: HarnessProcessCheckpointInput;
  readonly phase: "intent" | "committed" | "retained";
  readonly result?: HarnessDurableStateCheckpointResult;
  readonly failure?: "commit-unknown" | "receipt-mismatch" | "persistence-unknown";
}

export const completionKey = (runId: string, processOperationId: string, requestId: string) =>
  `harness-process-completion/v1/${encodeURIComponent(runId)}/${encodeURIComponent(processOperationId)}/${encodeURIComponent(requestId)}`;

export async function readCommittedCompletion(input: {
  readonly storage: DurableObjectStorage;
  readonly durableForRun: (runId: string) => HarnessDurableState;
  readonly assertCurrent: () => Promise<void>;
  readonly input: HarnessProcessCheckpointInput;
  readonly key: string;
}): Promise<Extract<HarnessDurableStateCheckpointResult, { status: "committed" }>> {
  const { storage, durableForRun, assertCurrent, key } = input;
  const completionInput = input.input;
  await assertCurrent();

  const prior = await storage.get<CompletionRecord>(key);
  if (
    prior === undefined ||
    !sameData(prior.input, completionInput) ||
    prior.phase !== "committed" ||
    prior.result?.status !== "committed"
  )
    throw new Error("The completion attempt needs explicit repair; it cannot be replayed.");
  const result = prior.result;
  const ownership = await readTerminalOwnership(storage, completionInput, prior);
  const prepared = await prepareCheckpoint(completionInput.checkpoint);
  if (
    prepared.checkpointId !== completionInput.checkpoint.checkpointId ||
    prepared.parentCheckpointId !== completionInput.checkpoint.parentCheckpointId ||
    result.files.checkpoint.checkpointId !== prepared.checkpointId ||
    result.files.parentCheckpointId !== prepared.parentCheckpointId ||
    result.files.checkpoint.manifestSha256 !== prepared.manifestSha256 ||
    result.files.checkpoint.manifestSha256 !==
      ownership.terminal.finish.checkpoint.filesystem.sha256 ||
    !sameData(ownership.terminal.completion, result)
  )
    throw new Error("The persisted completion bytes do not match terminal checkpoint evidence.");

  const durable = durableForRun(completionInput.runId);
  const runBefore = await durable.runStore.execute({
    type: "read",
    runId: completionInput.runId,
  });
  assertCompletedRunStore(ownership.owned, ownership.terminal, runBefore.snapshot, prepared);
  const currentBefore = await durable.threadSupervisor.execute({
    type: "read",
    runId: completionInput.runId,
    control: completionInput.control,
  });
  assertCurrentSupervisor(completionInput, result, currentBefore);
  const runAfter = await durable.runStore.execute({
    type: "read",
    runId: completionInput.runId,
  });
  if (!sameData(runBefore.snapshot, runAfter.snapshot))
    throw new Error("The run journal changed while the cached completion was reauthenticated.");
  const currentAfter = await durable.threadSupervisor.execute({
    type: "read",
    runId: completionInput.runId,
    control: completionInput.control,
  });
  assertCurrentSupervisor(completionInput, result, currentAfter);
  if (
    currentBefore.snapshot.lifecycle !== currentAfter.snapshot.lifecycle ||
    currentBefore.snapshot.admittedStepId !== currentAfter.snapshot.admittedStepId ||
    !sameReference(currentBefore.snapshot.checkpoint, currentAfter.snapshot.checkpoint) ||
    !samePublisher(currentBefore.currentPublisher, currentAfter.currentPublisher)
  )
    throw new Error("A changed while the cached completion was reauthenticated.");

  await assertCurrent();
  const confirmedOwnership = await readTerminalOwnership(storage, completionInput, prior);
  const confirmedCompletion = await storage.get<CompletionRecord>(key);
  if (
    !sameData(ownership.owned, confirmedOwnership.owned) ||
    !sameData(ownership.terminal, confirmedOwnership.terminal) ||
    !sameData(ownership.currentFence, confirmedOwnership.currentFence) ||
    !sameData(prior, confirmedCompletion)
  )
    throw new Error("The completion ownership changed while its receipt was reauthenticated.");
  await assertCurrent();
  return result;
}

async function readTerminalOwnership(
  storage: DurableObjectStorage,
  input: HarnessProcessCheckpointInput,
  completion: CompletionRecord,
) {
  const key = ownedRequestKey(input.runId, input.processOperationId, input.requestId);
  const expectedTerminalKey = terminalKey(input.runId, input.processOperationId, input.requestId);
  const snapshot = await storage.transaction(async (transaction) => {
    const active = await transaction.get<string>(activeKey(input.runId));
    const raw = await transaction.get<unknown>(key);
    if (active !== key || raw === undefined)
      throw new Error("The committed request is no longer the active owned process.");
    const owned = readOwned(raw);
    const currentFenceRaw = await transaction.get<ProcessFence>(localFenceKey);
    const historyRaw = await transaction.get<ProcessFence>(
      fenceHistoryKey(owned.fence.incarnation),
    );
    const terminal = await transaction.get<ProcessTerminalEvidence>(expectedTerminalKey);
    if (
      currentFenceRaw === undefined ||
      historyRaw === undefined ||
      terminal === undefined ||
      owned.terminalKey !== expectedTerminalKey ||
      owned.resumeClaim !== undefined ||
      owned.retained
    )
      throw new Error("The committed request has no current terminal ownership chain.");
    const currentFence = readProcessFence(currentFenceRaw);
    const sourceFence = readProcessFence(owned.fence);
    const historyFence = readProcessFence(historyRaw);
    if (
      currentFence.owner !== sourceFence.owner ||
      currentFence.incarnation < sourceFence.incarnation ||
      (currentFence.incarnation === sourceFence.incarnation &&
        !sameProcessFence(currentFence, sourceFence)) ||
      !sameProcessFence(historyFence, sourceFence) ||
      owned.placement.owner !== currentFence.owner ||
      (owned.legacySource === undefined &&
        owned.placement.shardIncarnationNonce !== sourceFence.nonce) ||
      (owned.legacySource !== undefined && owned.legacySource.terminalKey !== expectedTerminalKey)
    )
      throw new Error("The committed request belongs to another process-shard incarnation.");
    return { owned, terminal, currentFence };
  });

  const { owned, terminal } = snapshot;
  if (
    owned.runId !== input.runId ||
    owned.process.processId !== input.processId ||
    owned.process.operationId !== input.processOperationId ||
    owned.process.nativeSessionId !== input.nativeSessionId ||
    owned.placement.executionOperationId !== input.executionOperationId ||
    owned.request.requestId !== input.requestId ||
    !sameControl(owned.control, input.control) ||
    !samePublisher(owned.publisher, input.publisher) ||
    owned.runStorePublisher.generation !== input.publisher.generation ||
    owned.runStorePublisher.facetNonce !== input.publisher.facetNonce ||
    owned.parentCheckpoint.native.id !== input.checkpoint.parentCheckpointId ||
    !sameData(terminal.request, owned.request) ||
    terminal.version !== 1 ||
    terminal.runId !== owned.runId ||
    terminal.processId !== owned.process.processId ||
    terminal.processOperationId !== owned.process.operationId ||
    terminal.nativeSessionId !== owned.process.nativeSessionId ||
    !sameControl(terminal.control, owned.control) ||
    !samePublisher(terminal.publisher, owned.publisher) ||
    !sameData(terminal.placement, owned.placement) ||
    !sameData(terminal.identity, owned.identity) ||
    terminal.stopped !== true ||
    terminal.joined.invocationRpc !== true ||
    terminal.joined.fetch !== true ||
    terminal.joined.ports !== true ||
    terminal.finish.status !== "completed" ||
    completion.result?.status !== "committed" ||
    !terminal.acknowledgementId
  )
    throw new Error("The terminal evidence does not match the committed request.");
  return snapshot;
}

function assertCompletedRunStore(
  owned: DurableOwnedRequest,
  terminal: ProcessTerminalEvidence,
  snapshot: HarnessRunSnapshot,
  prepared: Awaited<ReturnType<typeof prepareCheckpoint>>,
) {
  const requests = snapshot.requests;
  const entry = requests?.entries.at(-1);
  const facet = requests?.facets.at(-1);
  if (
    requests === undefined ||
    entry === undefined ||
    facet === undefined ||
    entry.request.requestId !== owned.request.requestId ||
    !sameData(entry.request, owned.request) ||
    entry.status !== "completed" ||
    entry.finish === null ||
    entry.finish.status !== "completed" ||
    !sameData(entry.finish, terminal.finish) ||
    entry.generation !== owned.runStorePublisher.generation ||
    entry.facetNonce !== owned.runStorePublisher.facetNonce ||
    facet.operationId !== owned.process.operationId ||
    facet.generation !== owned.runStorePublisher.generation ||
    facet.facetNonce !== owned.runStorePublisher.facetNonce ||
    !sameCheckpoint(requests.checkpoint, entry.finish.checkpoint) ||
    !sameCheckpoint(requests.checkpoint, terminal.finish.checkpoint) ||
    requests.checkpoint.native.id !== prepared.checkpointId ||
    requests.checkpoint.filesystem.sha256 !== prepared.manifestSha256
  )
    throw new Error("The current run journal does not confirm this completed checkpoint.");
}

function assertCurrentSupervisor(
  input: HarnessProcessCheckpointInput,
  result: Extract<HarnessDurableStateCheckpointResult, { status: "committed" }>,
  current: Awaited<ReturnType<HarnessDurableState["threadSupervisor"]["execute"]>>,
) {
  if (
    current.snapshot.ownerId !== input.control.ownerId ||
    current.snapshot.controlEpoch !== input.control.epoch ||
    current.snapshot.controlIncarnationId !== input.control.incarnationId ||
    current.snapshot.nativeSessionId !== input.nativeSessionId ||
    current.snapshot.admittedStepId !== null ||
    (current.snapshot.lifecycle !== "accepting" && current.snapshot.lifecycle !== "draining") ||
    !samePublisher(current.currentPublisher, input.publisher) ||
    !sameReference(current.snapshot.checkpoint, result.files.checkpoint) ||
    !sameReference(result.supervisor.snapshot.checkpoint, result.files.checkpoint) ||
    !samePublisher(result.supervisor.currentPublisher, input.publisher) ||
    result.supervisor.snapshot.nativeSessionId !== input.nativeSessionId ||
    result.supervisor.snapshot.admittedStepId !== null
  )
    throw new Error("The current thread authority no longer confirms this completion receipt.");
}

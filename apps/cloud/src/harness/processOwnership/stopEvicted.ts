import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { NormalizedContinuation } from "../processResume/continuation.ts";
import { snapshotContinuation } from "../processResume/continuation.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import { activeKey, ownedRequestKey, readOwned } from "./ownedRequest.ts";
import { fenceHistoryKey, readProcessFence, sameProcessFence, type ProcessFence } from "./fence.ts";
import { processBoundaryKey, type ProcessBoundary } from "./boundary.ts";
import { retireEvictedBoundary } from "./restore.ts";
import { sameData } from "../processResume/checkpointContract.ts";

export interface EvictedStopReceipt {
  readonly version: 1;
  readonly phase: "stopped";
  readonly operationId: string;
  readonly request: NormalizedContinuation;
  readonly source: ProcessBoundary;
  readonly sourceFence: ProcessFence;
  readonly observedBy: ProcessFence;
}

export const evictedStopKey = (runId: string, requestId: string) =>
  `harness-process-evicted-stop/v1/${encodeURIComponent(runId)}/${encodeURIComponent(requestId)}`;

export function readEvictedStopReceipt(value: unknown): EvictedStopReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The evicted-stop receipt is malformed.");
  const receipt = value as Record<string, unknown>;
  const source = receipt.source as ProcessBoundary | undefined;
  const request = snapshotContinuation(receipt.request);
  const sourceFence = readProcessFence(receipt.sourceFence);
  const observedBy = readProcessFence(receipt.observedBy);
  if (
    source === undefined ||
    receipt.version !== 1 ||
    receipt.phase !== "stopped" ||
    typeof receipt.operationId !== "string" ||
    receipt.operationId.length === 0 ||
    !sameData(request, receipt.request) ||
    source.version !== 1 ||
    source.phase !== "idle" ||
    !sameProcessFence(source.fence, sourceFence) ||
    sourceFence.owner !== observedBy.owner ||
    sourceFence.incarnation >= observedBy.incarnation ||
    sourceFence.nonce === observedBy.nonce
  )
    throw new Error("The evicted-stop receipt does not identify a destroyed parent boundary.");
  return structuredClone({
    version: 1 as const,
    phase: "stopped" as const,
    operationId: receipt.operationId,
    request,
    source,
    sourceFence,
    observedBy,
  });
}

export function assertEvictedStopBoundary(receipt: EvictedStopReceipt, boundary: ProcessBoundary) {
  const lastRequest = receipt.source.lastRequest;
  if (
    boundary.phase !== "stopped" ||
    !sameData({ ...receipt.source, phase: "stopped" }, boundary) ||
    !sameProcessFence(receipt.sourceFence, receipt.source.fence) ||
    lastRequest?.settlement.processRetained !== true ||
    !lastRequest?.settlement.joined.invocationRpc ||
    receipt.operationId !==
      `eviction-stop-${receipt.source.fence.incarnation}-${lastRequest?.request.requestId}` ||
    receipt.request.runId !== boundary.runId ||
    receipt.request.processId !== boundary.process.processId ||
    receipt.request.executionOperationId !== boundary.placement.executionOperationId ||
    receipt.request.resumeOperationId !== boundary.callerOperationId ||
    !sameData(receipt.request.control, boundary.control) ||
    receipt.request.runStore.controlKey !== boundary.runStore.controlKey ||
    !sameData(receipt.request.runStore.supervisor, boundary.runStore.supervisor) ||
    (!sameData(receipt.request.runStore.currentPublisher, boundary.callerPublisher) &&
      !sameData(receipt.request.runStore.currentPublisher, boundary.requestPublisher)) ||
    !sameData(receipt.request.runStore.request, boundary.lastRequest?.request) ||
    !sameData(receipt.request.runStore.checkpoint, boundary.checkpoint)
  )
    throw new Error("The evicted-stop receipt no longer matches its durable process boundary.");
}

export async function stopEvictedProcess(input: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly incarnation: ProcessIncarnation;
  readonly boundary: ProcessBoundary;
  readonly request: NormalizedContinuation;
}) {
  const { context, boundary, request } = input;
  const key = evictedStopKey(boundary.runId, request.runStore.request.requestId);
  const previous = await context.storage.get<unknown>(key);
  if (previous !== undefined) {
    const receipt = readEvictedStopReceipt(previous);
    if (!sameData(receipt.request, request))
      throw new Error("The evicted stop is uncertain or belongs to another request.");
    const currentFence = await input.incarnation.assertCurrent();
    assertEvictedStopBoundary(receipt, boundary);
    const sourceHistory = await context.storage.get<ProcessFence>(
      fenceHistoryKey(receipt.sourceFence.incarnation),
    );
    const observedHistory = await context.storage.get<ProcessFence>(
      fenceHistoryKey(receipt.observedBy.incarnation),
    );
    if (
      sourceHistory === undefined ||
      observedHistory === undefined ||
      !sameProcessFence(readProcessFence(sourceHistory), receipt.sourceFence) ||
      !sameProcessFence(readProcessFence(observedHistory), receipt.observedBy) ||
      currentFence.owner !== receipt.observedBy.owner ||
      currentFence.incarnation < receipt.observedBy.incarnation
    )
      throw new Error("The evicted-stop receipt is absent from the current shard fence history.");
    const current = await createHarnessDurableState(
      input.environment,
      boundary.runId,
    ).threadSupervisor.execute({ type: "read", runId: boundary.runId, control: request.control });
    if (
      current.snapshot.lifecycle !== "recoverable" ||
      current.snapshot.admittedStepId !== null ||
      current.snapshot.nativeSessionId !== boundary.nativeSessionId ||
      !sameData(current.snapshot.checkpoint, {
        checkpointId: boundary.checkpoint.native.id,
        manifestSha256: boundary.checkpoint.filesystem.sha256,
      }) ||
      !sameData(current.currentPublisher, boundary.prepared.preparedPublisher)
    )
      throw new Error("The stopped process no longer has the same durable authority.");
    return { status: "stopped" as const };
  }
  if (
    boundary.phase !== "idle" ||
    boundary.lastRequest === undefined ||
    !sameData(boundary.lastRequest.request, request.runStore.request)
  )
    throw new Error("The stop does not identify the last completed idle request.");
  const ownedKey = boundary.lastRequest.ownedKey;
  if (
    (await context.storage.get(activeKey(boundary.runId))) !== ownedKey ||
    ownedKey !==
      ownedRequestKey(
        boundary.runId,
        boundary.process.operationId,
        request.runStore.request.requestId,
      )
  )
    throw new Error("The idle stop no longer owns the active durable process request.");
  const owned = readOwned(await context.storage.get(ownedKey));
  if (
    owned.retained ||
    owned.terminalKey !== undefined ||
    owned.resumeClaim !== undefined ||
    !sameProcessFence(owned.fence, boundary.fence) ||
    !sameData(owned.request, boundary.lastRequest.request) ||
    !sameData(owned.identity, boundary.prepared.identity) ||
    !sameData(owned.placement, boundary.placement) ||
    !sameData(owned.control, boundary.control) ||
    !sameData(owned.publisher, boundary.prepared.preparedPublisher) ||
    !sameData(owned.runStorePublisher, boundary.requestPublisher)
  )
    throw new Error("The idle stop does not match the active durable owned request.");
  const durable = createHarnessDurableState(input.environment, boundary.runId);
  const reserved = {
    version: 1 as const,
    phase: "reserved" as const,
    operationId: `eviction-stop-${boundary.fence.incarnation}-${request.runStore.request.requestId}`,
    request,
    source: boundary,
    sourceFence: boundary.fence,
  };
  await context.storage.transaction(async (transaction) => {
    await input.incarnation.assertCurrent();
    if (
      (await transaction.get(key)) !== undefined ||
      (await transaction.get(activeKey(boundary.runId))) !== ownedKey ||
      !sameData(await transaction.get(ownedKey), owned) ||
      !sameData(await transaction.get(processBoundaryKey(boundary.runId)), boundary)
    )
      throw new Error("Another durable owner changed the evicted-stop source.");
    await transaction.put(key, reserved);
  });
  const currentFence = await retireEvictedBoundary({
    ...input,
    durable,
    operationId: reserved.operationId,
  });
  // Destruction is the cleanup evidence. No native stop RPC or graceful-join reply is invented.
  await context.storage.transaction(async (transaction) => {
    await input.incarnation.assertCurrent();
    if (
      !sameData(await transaction.get(key), reserved) ||
      (await transaction.get(activeKey(boundary.runId))) !== ownedKey ||
      !sameData(await transaction.get(ownedKey), owned) ||
      !sameData(await transaction.get(processBoundaryKey(boundary.runId)), boundary)
    )
      throw new Error("The evicted-stop source changed before its destruction receipt committed.");
    await transaction.put(key, {
      ...reserved,
      request,
      phase: "stopped",
      observedBy: currentFence,
    });
    await transaction.put(processBoundaryKey(boundary.runId), { ...boundary, phase: "stopped" });
  });
  return { status: "stopped" as const };
}

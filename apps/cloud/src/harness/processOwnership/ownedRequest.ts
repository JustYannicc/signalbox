import * as Schema from "effect/Schema";
import {
  id,
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../durableState/shared.ts";
import { HarnessProcessResumeRunStoreBindingSchema } from "../processResume/contracts.ts";
import type { HarnessProcessResumeOperationInput } from "../processResume/contracts.ts";
import type { OwnedProcessRequest } from "../processResume/executionState.ts";
import type { ProcessTerminalEvidence } from "../processResume/terminalContract.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { fenceHistoryKey, ProcessFence, readProcessFence, sameProcessFence } from "./fence.ts";
import type { ProcessIncarnation } from "./incarnation.ts";

const journal = HarnessProcessResumeRunStoreBindingSchema.fields;
const OwnedRequest = Schema.Struct({
  version: Schema.Literal(1),
  retained: Schema.Boolean,
  runId: id,
  process: Schema.Struct({ processId: id, operationId: id, nativeSessionId: id }),
  request: journal.request,
  control: HarnessThreadSupervisorControlClaim,
  publisher: HarnessThreadSupervisorPublisher,
  runStorePublisher: journal.currentPublisher,
  parentCheckpoint: journal.checkpoint,
  placement: Schema.Struct({
    owner: Schema.NonEmptyString,
    executionOperationId: id,
    shardOwner: Schema.NonEmptyString,
    shardIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    shardIncarnationNonce: id,
  }),
  identity: Schema.Struct({
    shardOwner: Schema.NonEmptyString,
    loaderId: id,
    facetKey: id,
    incarnationNonce: id,
  }),
  fence: ProcessFence,
  previousOwnedKey: Schema.optionalKey(Schema.NonEmptyString),
  terminalKey: Schema.optionalKey(Schema.NonEmptyString),
  legacySource: Schema.optionalKey(
    Schema.Struct({
      version: Schema.Literal(1),
      terminalKey: Schema.NonEmptyString,
      completionKey: Schema.NonEmptyString,
    }),
  ),
  resumeClaim: Schema.optionalKey(
    Schema.Struct({
      operationId: id,
      fence: ProcessFence,
      nextControl: HarnessThreadSupervisorControlClaim,
    }),
  ),
});
export type DurableOwnedRequest = typeof OwnedRequest.Type;
export const readOwned = Schema.decodeUnknownSync(OwnedRequest, { onExcessProperty: "error" });
export const activeKey = (runId: string) =>
  `harness-owned-process/v1/active/${encodeURIComponent(runId)}`;
export const ownedRequestKey = (runId: string, operationId: string, requestId: string) =>
  `harness-owned-process/v1/${encodeURIComponent(runId)}/${encodeURIComponent(operationId)}/${encodeURIComponent(requestId)}`;

function snapshotIdentity(owned: OwnedProcessRequest) {
  return structuredClone({
    version: 1 as const,
    retained: owned.retained,
    runId: owned.runId,
    process: {
      processId: owned.process.processId,
      operationId: owned.process.operationId,
      nativeSessionId: owned.process.nativeSessionId,
    },
    request: owned.request,
    control: owned.control,
    publisher: owned.publisher,
    runStorePublisher: owned.runStorePublisher,
    parentCheckpoint: owned.parentCheckpoint,
    placement: owned.placement,
    identity: owned.handle.identity,
  });
}

export async function saveOwnedRequest(
  storage: DurableObjectStorage,
  owned: OwnedProcessRequest,
  incarnation: ProcessIncarnation,
) {
  const fence = await incarnation.assertCurrent();
  const key = ownedRequestKey(owned.runId, owned.process.operationId, owned.request.requestId);
  const identity = snapshotIdentity(owned);
  if (
    identity.placement.owner !== fence.owner ||
    identity.placement.shardIncarnationNonce !== fence.nonce
  )
    throw new Error("The process activation belongs to another shard incarnation.");
  await storage.transaction(async (transaction) => {
    if ((await transaction.get(key)) !== undefined)
      throw new Error(
        "This process request already has durable ownership; execution cannot replay.",
      );
    const previousOwnedKey = await transaction.get<string>(activeKey(owned.runId));
    const record = readOwned({
      ...identity,
      fence,
      ...(previousOwnedKey === undefined ? {} : { previousOwnedKey }),
    });
    await transaction.put(key, record);
    await transaction.put(activeKey(owned.runId), key);
  });
}

export async function markOwnedRequestTerminal(
  transaction: DurableObjectTransaction,
  owned: OwnedProcessRequest,
  terminalKey: string,
) {
  const key = ownedRequestKey(owned.runId, owned.process.operationId, owned.request.requestId);
  const record = readOwned(await transaction.get(key));
  const {
    fence: _fence,
    previousOwnedKey: _previousOwnedKey,
    terminalKey: previousTerminal,
    legacySource: _legacySource,
    resumeClaim: _resumeClaim,
    ...identity
  } = record;
  const observed = snapshotIdentity(owned);
  if (
    !sameData({ ...identity, control: observed.control }, observed) ||
    (!sameData(record.control, owned.control) &&
      !sameData(record.resumeClaim?.nextControl, owned.control)) ||
    (previousTerminal !== undefined && previousTerminal !== terminalKey)
  )
    throw new Error("Terminal evidence does not match its durable owned process.");
  await transaction.put(key, { ...record, terminalKey });
}

export async function retainOwnedRequest(
  storage: DurableObjectStorage,
  owned: OwnedProcessRequest,
) {
  const key = ownedRequestKey(owned.runId, owned.process.operationId, owned.request.requestId);
  await storage.transaction(async (transaction) => {
    const record = readOwned(await transaction.get(key));
    if (!sameData(record.identity, owned.handle.identity))
      throw new Error("Retained ownership belongs to another process incarnation.");
    await transaction.put(key, { ...record, retained: true });
  });
}

/** Reserve the source step once. The active pointer and full source identity live in C storage. */
export async function reserveOwnedResume(
  storage: DurableObjectStorage,
  operation: HarnessProcessResumeOperationInput,
  incarnation: ProcessIncarnation,
  eviction?: {
    readonly receiptKey: string;
    readonly receipt: unknown;
    readonly boundaryKey: string;
    readonly boundary: unknown;
    readonly expectedRecord: DurableOwnedRequest;
    readonly sourceFence: ProcessFence;
    readonly observedBy: ProcessFence;
    readonly reservationFence: ProcessFence;
  },
) {
  const fence = await incarnation.assertCurrent();
  const key = ownedRequestKey(
    operation.runId,
    operation.previousOperationId,
    operation.previousStepId,
  );
  return storage.transaction(async (transaction) => {
    const record = readOwned(await transaction.get(key));
    const history = await transaction.get<ProcessFence>(fenceHistoryKey(record.fence.incarnation));
    if (
      (await transaction.get(activeKey(operation.runId))) !== key ||
      record.runId !== operation.runId ||
      record.process.processId !== operation.previousProcessId ||
      record.process.operationId !== operation.previousOperationId ||
      record.request.requestId !== operation.previousStepId ||
      record.retained ||
      !sameData(operation.transition.control, record.control) ||
      !sameData(operation.transition.publisher, record.publisher) ||
      !sameData(operation.runStore.currentPublisher, record.runStorePublisher) ||
      !sameData(operation.runStore.request, record.request) ||
      !sameData(operation.runStore.checkpoint, record.parentCheckpoint) ||
      record.fence.owner !== fence.owner ||
      record.placement.owner !== fence.owner ||
      (record.legacySource === undefined &&
        record.placement.shardIncarnationNonce !== record.fence.nonce) ||
      (record.legacySource !== undefined &&
        (record.terminalKey === undefined ||
          record.legacySource.terminalKey !== record.terminalKey)) ||
      record.fence.incarnation > fence.incarnation ||
      history === undefined ||
      !sameProcessFence(history, record.fence)
    )
      throw new Error("Resume does not identify the exact durable owned process and request.");
    const evictionMatches = async () => {
      if (eviction === undefined) return false;
      const receipt = eviction.receipt as {
        readonly version?: unknown;
        readonly phase?: unknown;
        readonly source?: { readonly phase?: unknown; readonly fence?: unknown };
        readonly sourceFence?: unknown;
        readonly observedBy?: unknown;
      };
      const source = receipt.source;
      const boundary = eviction.boundary as { readonly phase?: unknown };
      if (source === undefined) return false;
      return (
        eviction.receiptKey ===
          `harness-process-evicted-stop/v1/${encodeURIComponent(operation.runId)}/${encodeURIComponent(operation.previousStepId)}` &&
        eviction.boundaryKey ===
          `harness-process-boundary/v1/${encodeURIComponent(operation.runId)}` &&
        eviction.reservationFence.owner === fence.owner &&
        sameProcessFence(eviction.reservationFence, fence) &&
        sameProcessFence(eviction.sourceFence, record.fence) &&
        eviction.sourceFence.owner === eviction.observedBy.owner &&
        eviction.sourceFence.incarnation < eviction.observedBy.incarnation &&
        eviction.observedBy.incarnation <= fence.incarnation &&
        eviction.sourceFence.nonce !== eviction.observedBy.nonce &&
        receipt.version === 1 &&
        receipt.phase === "stopped" &&
        source.phase === "idle" &&
        sameProcessFence(readProcessFence(source.fence), eviction.sourceFence) &&
        sameProcessFence(readProcessFence(receipt.sourceFence), eviction.sourceFence) &&
        sameProcessFence(readProcessFence(receipt.observedBy), eviction.observedBy) &&
        boundary.phase === "stopped" &&
        sameData({ ...receipt.source, phase: "stopped" }, eviction.boundary) &&
        sameData(await transaction.get(eviction.receiptKey), eviction.receipt) &&
        sameData(await transaction.get(eviction.boundaryKey), eviction.boundary) &&
        sameData(record, eviction.expectedRecord)
      );
    };
    const matchesEviction = eviction === undefined ? false : await evictionMatches();
    if (record.resumeClaim !== undefined)
      throw new Error("The source step already has a resume reservation; replay is forbidden.");
    if (record.terminalKey === undefined && !sameProcessFence(record.fence, fence)) {
      if (!matchesEviction)
        throw new Error(
          "The source process has no durable terminal handoff or exact parent-destruction receipt; explicit repair is required.",
        );
    }
    if (eviction !== undefined && !matchesEviction)
      throw new Error("The parent-destruction reservation no longer matches its durable receipt.");
    if (record.terminalKey !== undefined)
      assertTerminal(record, await transaction.get<ProcessTerminalEvidence>(record.terminalKey));
    await transaction.put(key, {
      ...record,
      resumeClaim: {
        operationId: operation.transition.operationId,
        fence,
        nextControl: operation.transition.nextControl,
      },
    });
    return record;
  });
}

function assertTerminal(
  record: DurableOwnedRequest,
  terminal: ProcessTerminalEvidence | undefined,
) {
  if (
    record.retained ||
    terminal?.version !== 1 ||
    terminal.runId !== record.runId ||
    terminal.processId !== record.process.processId ||
    terminal.processOperationId !== record.process.operationId ||
    terminal.nativeSessionId !== record.process.nativeSessionId ||
    !sameData(terminal.request, record.request) ||
    (!sameData(terminal.control, record.control) &&
      !sameData(terminal.control, record.resumeClaim?.nextControl)) ||
    !sameData(terminal.publisher, record.publisher) ||
    !sameData(terminal.placement, record.placement) ||
    !sameData(terminal.identity, record.identity) ||
    terminal.stopped !== true ||
    !terminal.joined.invocationRpc ||
    !terminal.joined.fetch ||
    !terminal.joined.ports
  )
    throw new Error("The durable terminal handoff does not match the source incarnation chain.");
  return terminal;
}

export async function readOwnedTerminal(
  storage: DurableObjectStorage,
  source: DurableOwnedRequest,
  operationId: string,
) {
  const key = ownedRequestKey(source.runId, source.process.operationId, source.request.requestId);
  const record = readOwned(await storage.get(key));
  const { terminalKey, resumeClaim, retained, ...identity } = record;
  const {
    terminalKey: _priorTerminal,
    resumeClaim: _priorClaim,
    retained: _priorRetained,
    ...original
  } = source;
  if (
    retained ||
    !sameData(identity, original) ||
    resumeClaim?.operationId !== operationId ||
    terminalKey === undefined
  )
    throw new Error("The previous process has no exact completed durable handoff.");
  return assertTerminal(record, await storage.get<ProcessTerminalEvidence>(terminalKey));
}

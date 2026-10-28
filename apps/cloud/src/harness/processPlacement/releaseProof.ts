import type { ProcessSlotState } from "../../computer/ProcessSlots.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { terminalKey } from "../processResume/terminalContract.ts";
import {
  fenceHistoryKey,
  localFenceKey,
  readProcessFence,
  sameProcessFence,
} from "../processOwnership/fence.ts";
import type { HarnessProcessPlacementWriter } from "./storeSchema.ts";
import {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  parseRecoveryRecord,
  sameClaim,
  sameWriter,
  sameEvictedRecoverySource,
  sameProcessPlacementIdentity,
} from "./storeSchema.ts";
import {
  stopKey,
  type PlacementReleaseEvidence,
  type PlacementStopReceipt,
} from "./releaseEvidence.ts";
import {
  followsPlacementWriterClaims,
  isUnopenedPlacement,
  type PlacementWriterClaim,
} from "./releaseObservations.ts";

export function selectPlacementReleaseProof(input: {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly evidence: PlacementReleaseEvidence;
  readonly retirements: ReadonlyMap<string, unknown>;
  readonly receiverFence: unknown;
  readonly slots: ProcessSlotState | undefined;
  readonly recoveryCount: number;
  readonly stops?: ReadonlyMap<string, PlacementStopReceipt>;
  readonly claims?: ReadonlyMap<string, PlacementWriterClaim>;
}) {
  const { owner, writer, evidence } = input;
  if (
    input.slots?.owner !== owner ||
    input.slots.slots.some(
      (slot) => slot.holder !== undefined || slot.invalidating !== undefined,
    ) ||
    input.recoveryCount !== 0
  )
    throw new Error("Placement release still has held slots or recovery records.");
  const stops = [...(input.stops ?? [])]
    .filter(([, stop]) => sameWriter(stop.writer, writer))
    .map(([key, stop]) => {
      const record = parseRecoveryRecord(stop.record, owner);
      if (
        stop.owner !== owner ||
        key !== stopKey(owner, writer, record.loaderId) ||
        !sameClaim(record.controllerClaim, writer.controllerClaim) ||
        (!isUnopenedPlacement(record) &&
          (!record.stopAcknowledged ||
            !record.joined.invocationRpc ||
            !record.joined.fetch ||
            !record.joined.ports)) ||
        record.terminalFailure !== undefined
      )
        throw new Error("Placement release has mismatched stop/join evidence.");
      return record;
    });
  const terminalRows = evidence.terminal.filter(
    ([key, row]) =>
      row.placement.owner === owner &&
      row.placement.executionOperationId === writer.executionOperationId &&
      row.placement.shardIndex === writer.shardIndex &&
      row.placement.shardIncarnationNonce === writer.shardIncarnationNonce &&
      evidence.terminalOwners.some(
        (owned) => owned.key === key && sameWriter(owned.writer, writer),
      ),
  );
  const terminals = terminalRows.map(([, row]) => row);
  if (terminals.length > 0) {
    if (
      terminalRows.some(
        ([key, row]) =>
          key !== terminalKey(row.runId, row.processOperationId, row.request.requestId),
      )
    )
      throw new Error("Placement release has a mismatched C terminal key.");
    if (
      terminals.some(
        (row) =>
          row.stopped !== true ||
          row.joined.invocationRpc !== true ||
          row.joined.fetch !== true ||
          row.joined.ports !== true ||
          !row.acknowledgementId ||
          row.identity.shardOwner !== owner ||
          row.identity.loaderId !== row.identity.facetKey ||
          !row.identity.incarnationNonce,
      )
    )
      throw new Error("Placement release has incomplete exact C stop/join evidence.");
    for (const [key, row] of terminalRows) {
      if (
        !evidence.terminalOwners.some(
          (owned) =>
            owned.key === key &&
            sameWriter(owned.writer, writer) &&
            sameProcessPlacementIdentity(owned.identity, row.identity) &&
            owned.runId === row.runId &&
            owned.process.processId === row.processId &&
            owned.process.operationId === row.processOperationId &&
            owned.process.nativeSessionId === row.nativeSessionId &&
            sameData(owned.request, row.request) &&
            sameData(owned.publisher, row.publisher) &&
            sameData(owned.placement, row.placement) &&
            (sameClaim(row.control, owned.writer.controllerClaim) ||
              (owned.nextControl !== undefined && sameClaim(row.control, owned.nextControl))),
        )
      )
        throw new Error("C stop/join evidence is not bound to the releasing placement writer.");
    }
    return { kind: "graceful-stop" as const, terminals, stops };
  }

  // Unopened stubs need no stop RPC. Opened inert facets still need their real stop/join.
  if (
    stops.length > 0 &&
    stops.every(
      (record) =>
        (isUnopenedPlacement(record) || record.invocationMayHaveStarted === false) &&
        record.publicationReceipt === undefined &&
        (record.publicationState === undefined || record.publicationState === "not-published"),
    )
  )
    return { kind: "inert-cleanup" as const, terminals, stops };

  const fences = new Map(evidence.fences);
  const currentFence = readProcessFence(fences.get(localFenceKey));
  const receiver = readProcessFence(input.receiverFence);
  if (
    currentFence.owner !== owner ||
    currentFence.nonce !== writer.shardIncarnationNonce ||
    !sameProcessFence(currentFence, receiver)
  )
    throw new Error("Placement release has no exact current parent fence.");
  const matches = [...input.retirements]
    .map(([key, value]) => {
      const receipt = parseEvictedRecoveryReceipt(value);
      return { key, receipt };
    })
    .filter(({ key, receipt }) =>
      followsPlacementWriterClaims(key, receipt, writer, currentFence, input.claims, fences),
    );
  if (matches.length !== 1)
    throw new Error("Placement release has no unique exact parent-destruction receipt.");
  const { key, receipt } = matches[0]!;
  if (
    receipt.state !== "completed" ||
    receipt.owner !== owner ||
    !evidence.sources.some((source) => sameEvictedRecoverySource(receipt, source)) ||
    key !== evictedRecoveryKey(owner, receipt.sourceFence, receipt.identity) ||
    !sameProcessFence(
      readProcessFence(fences.get(fenceHistoryKey(receipt.currentFence.incarnation))),
      receipt.currentFence,
    ) ||
    !sameProcessFence(
      readProcessFence(fences.get(fenceHistoryKey(receipt.sourceFence.incarnation))),
      receipt.sourceFence,
    ) ||
    !sameProcessFence(
      readProcessFence(fences.get(fenceHistoryKey(currentFence.incarnation))),
      currentFence,
    )
  )
    throw new Error(
      "Placement release has mismatched or incomplete parent-destruction retirement.",
    );
  return { kind: "parent-destroyed" as const, receipt, terminals: [] };
}

export type PlacementReleaseProof = ReturnType<typeof selectPlacementReleaseProof>;
export type ObservedPlacementRelease = {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly evidence: PlacementReleaseEvidence;
  readonly proof: PlacementReleaseProof;
};

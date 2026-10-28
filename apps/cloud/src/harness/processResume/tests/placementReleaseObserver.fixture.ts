import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";
import type { HarnessProcessPlacementWriter } from "../../HarnessProcessPlacement.ts";
import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
import type { ProcessTerminalEvidence } from "../terminalContract.ts";
import { terminalKey } from "../terminalContract.ts";
import type { ProcessBoundary } from "../../processOwnership/boundary.ts";
import type { HarnessProcessPlacementRecoveryRecord } from "../../HarnessProcessPlacement.ts";
import type { DurableOwnedRequest } from "../../processOwnership/ownedRequest.ts";
import {
  EVICTED_RECOVERY_PREFIX,
  RECOVERY_PREFIX,
  STATE_KEY,
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  sameClaim,
  sameWriter,
  sameEvictedRecoverySource,
  parseRecoveryRecord,
  sameProcessPlacementIdentity,
  writerIdentityKey,
} from "../../processPlacement/storeSchema.ts";
import {
  fenceHistoryKey,
  assertProcessFenceNonce,
  localFenceKey,
  readProcessFence,
  receiverFenceKey,
  sameProcessFence,
} from "../../processOwnership/fence.ts";

export async function placementReleaseEvidence(storage: DurableObjectStorage) {
  const terminal = await storage.list<ProcessTerminalEvidence>({
    prefix: "harness-process-terminal/v1/",
  });
  const fences = await storage.list<unknown>({ prefix: "harness-process-incarnation/v1/" });
  const boundaries = await storage.list<ProcessBoundary>({
    prefix: "harness-process-boundary/v1/",
  });
  const owned = await storage.list<DurableOwnedRequest>({ prefix: "harness-owned-process/v1/" });
  const terminalOwners = [...owned.values()].flatMap((row) =>
    row.terminalKey === undefined
      ? []
      : [
          {
            key: row.terminalKey,
            writer: {
              executionOperationId: row.placement.executionOperationId,
              shardIndex: row.placement.shardIndex,
              shardIncarnationNonce: row.placement.shardIncarnationNonce,
              controllerClaim: row.control,
            },
            identity: row.identity,
            nextControl: row.resumeClaim?.nextControl,
          },
        ],
  );
  const sources = [...boundaries.values()].map((boundary) => ({
    owner: boundary.placement.owner,
    sourceFence: boundary.fence,
    sourceWriter: {
      executionOperationId: boundary.placement.executionOperationId,
      shardIndex: boundary.placement.shardIndex,
      shardIncarnationNonce: boundary.fence.nonce,
      controllerClaim: boundary.control,
    },
    processId: boundary.process.processId,
    identity: boundary.prepared.identity,
  }));
  return { terminal: [...terminal], fences: [...fences], sources, terminalOwners };
}

export type PlacementReleaseEvidence = Awaited<ReturnType<typeof placementReleaseEvidence>>;

const STOP_PREFIX = "proof/placement-stop/v1/";
interface PlacementStopReceipt {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly record: HarnessProcessPlacementRecoveryRecord;
}
const stopKey = (owner: string, writer: HarnessProcessPlacementWriter, loaderId: string) =>
  `${STOP_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(writerIdentityKey(writer))}/${encodeURIComponent(loaderId)}`;

export function selectPlacementReleaseProof(input: {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly evidence: PlacementReleaseEvidence;
  readonly retirements: ReadonlyMap<string, unknown>;
  readonly receiverFence: unknown;
  readonly slots: ProcessSlotState | undefined;
  readonly recoveryCount: number;
  readonly stops?: ReadonlyMap<string, PlacementStopReceipt>;
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
        !record.stopAcknowledged ||
        !record.joined.invocationRpc ||
        !record.joined.fetch ||
        !record.joined.ports ||
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
            (sameClaim(row.control, owned.writer.controllerClaim) ||
              (owned.nextControl !== undefined && sameClaim(row.control, owned.nextControl))),
        )
      )
        throw new Error("C stop/join evidence is not bound to the releasing placement writer.");
    }
    return { kind: "graceful-stop" as const, terminals, stops };
  }

  // An inert candidate has no native request terminal. Its real placement stop/join still owns cleanup.
  if (
    stops.length > 0 &&
    stops.every(
      (record) =>
        record.invocationMayHaveStarted === false &&
        record.publicationReceipt === undefined &&
        (record.publicationState === undefined || record.publicationState === "not-published"),
    )
  )
    return { kind: "graceful-stop" as const, terminals, stops };

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
    .filter(({ receipt }) => sameWriter(receipt.currentWriter, writer));
  if (matches.length !== 1)
    throw new Error("Placement release has no unique exact parent-destruction receipt.");
  const { key, receipt } = matches[0]!;
  if (
    receipt.state !== "completed" ||
    receipt.owner !== owner ||
    !evidence.sources.some((source) => sameEvictedRecoverySource(receipt, source)) ||
    key !== evictedRecoveryKey(owner, receipt.sourceFence, receipt.identity) ||
    !sameProcessFence(receipt.currentFence, currentFence) ||
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

// One release gate keeps public C tests and the native qualifier from accepting different evidence.
export class ObservedPlacementStore extends HarnessProcessPlacementStoreObject {
  override async removeRecovery(
    owner: string,
    writer: HarnessProcessPlacementWriter,
    loaderId: string,
  ) {
    const record = (await super.listRecovery(owner, writer)).find(
      (row) => row.loaderId === loaderId,
    );
    await super.removeRecovery(owner, writer, loaderId);
    if (record !== undefined)
      await this.ctx.storage.put(stopKey(owner, writer, loaderId), { owner, writer, record });
  }

  override async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    await this.ctx.storage.transaction((transaction) =>
      assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce),
    );
    const env = this.env as unknown as {
      PROCESS_EXECUTION_SHARDS: {
        getByName(owner: string): {
          placementReleaseEvidence(): Promise<PlacementReleaseEvidence>;
        };
      };
    };
    const evidence = await env.PROCESS_EXECUTION_SHARDS.getByName(owner).placementReleaseEvidence();
    const proof = selectPlacementReleaseProof({
      owner,
      writer,
      evidence,
      retirements: await this.ctx.storage.list<unknown>({ prefix: EVICTED_RECOVERY_PREFIX }),
      receiverFence: await this.ctx.storage.get<unknown>(receiverFenceKey(owner)),
      slots: await this.ctx.storage.get<ProcessSlotState>(STATE_KEY),
      recoveryCount: (await this.ctx.storage.list({ prefix: RECOVERY_PREFIX })).size,
      stops: await this.ctx.storage.list<PlacementStopReceipt>({ prefix: STOP_PREFIX }),
    });
    const observed = { owner, writer, evidence, proof };
    const sequence = await this.beforePlacementRelease(observed);
    await super.releaseWriter(owner, writer);
    if (
      (await super.readWriter(owner)) !== undefined ||
      !(await super.writerReleased(owner, writer))
    )
      throw new Error("Placement writer release is not durable.");
    await this.afterPlacementRelease(observed, sequence);
  }

  protected async beforePlacementRelease(
    _observed: ObservedPlacementRelease,
  ): Promise<number | undefined> {
    return undefined;
  }
  protected async afterPlacementRelease(
    _observed: ObservedPlacementRelease,
    _sequence: number | undefined,
  ): Promise<void> {}
}

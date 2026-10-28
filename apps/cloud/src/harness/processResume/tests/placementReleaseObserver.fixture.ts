import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";
import type { HarnessProcessPlacementWriter } from "../../HarnessProcessPlacement.ts";
import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
import type { ProcessTerminalEvidence } from "../terminalContract.ts";
import { terminalKey } from "../terminalContract.ts";
import type { ProcessBoundary } from "../../processOwnership/boundary.ts";
import {
  EVICTED_RECOVERY_PREFIX,
  RECOVERY_PREFIX,
  STATE_KEY,
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  sameClaim,
  sameWriter,
  sameEvictedRecoverySource,
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
  return { terminal: [...terminal], fences: [...fences], sources };
}

export type PlacementReleaseEvidence = Awaited<ReturnType<typeof placementReleaseEvidence>>;

export function selectPlacementReleaseProof(input: {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly evidence: PlacementReleaseEvidence;
  readonly retirements: ReadonlyMap<string, unknown>;
  readonly receiverFence: unknown;
  readonly slots: ProcessSlotState | undefined;
  readonly recoveryCount: number;
}) {
  const { owner, writer, evidence } = input;
  const terminalRows = evidence.terminal.filter(
    ([, row]) =>
      sameClaim(row.control, writer.controllerClaim) &&
      row.placement.owner === owner &&
      row.placement.executionOperationId === writer.executionOperationId &&
      row.placement.shardIndex === writer.shardIndex &&
      row.placement.shardIncarnationNonce === writer.shardIncarnationNonce,
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
    return { kind: "graceful-stop" as const, terminals };
  }

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
    ) ||
    input.slots?.owner !== owner ||
    input.slots.slots.some(
      (slot) => slot.holder !== undefined || slot.invalidating !== undefined,
    ) ||
    input.recoveryCount !== 0
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
  readonly evidence: { readonly placementRelease: PlacementReleaseEvidence };
  readonly proof: PlacementReleaseProof;
};

// Both public C tests and the native qualifier inherit the entire release observer.
export class ObservedPlacementStore extends HarnessProcessPlacementStoreObject {
  override async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    await this.ctx.storage.transaction((transaction) =>
      assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce),
    );
    const env = this.env as unknown as {
      PROCESS_EXECUTION_SHARDS: {
        getByName(owner: string): {
          evidence(): Promise<{ readonly placementRelease: PlacementReleaseEvidence }>;
        };
      };
    };
    const evidence = await env.PROCESS_EXECUTION_SHARDS.getByName(owner).evidence();
    const proof = selectPlacementReleaseProof({
      owner,
      writer,
      evidence: evidence.placementRelease,
      retirements: await this.ctx.storage.list<unknown>({ prefix: EVICTED_RECOVERY_PREFIX }),
      receiverFence: await this.ctx.storage.get<unknown>(receiverFenceKey(owner)),
      slots: await this.ctx.storage.get<ProcessSlotState>(STATE_KEY),
      recoveryCount: (await this.ctx.storage.list({ prefix: RECOVERY_PREFIX })).size,
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

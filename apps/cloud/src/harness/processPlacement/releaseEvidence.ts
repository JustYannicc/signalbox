import type { HarnessProcessPlacementRecoveryRecord } from "./contracts.ts";
import type { HarnessProcessPlacementWriter } from "./storeSchema.ts";
import { writerIdentityKey } from "./storeSchema.ts";
import type { ProcessTerminalEvidence } from "../processResume/terminalContract.ts";
import type { ProcessBoundary } from "../processOwnership/boundary.ts";
import type { DurableOwnedRequest } from "../processOwnership/ownedRequest.ts";

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
            runId: row.runId,
            process: row.process,
            request: row.request,
            publisher: row.publisher,
            placement: row.placement,
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

export const STOP_PREFIX = "proof/placement-stop/v1/";
export interface PlacementStopReceipt {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly record: HarnessProcessPlacementRecoveryRecord;
}
export const stopKey = (owner: string, writer: HarnessProcessPlacementWriter, loaderId: string) =>
  `${STOP_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(writerIdentityKey(writer))}/${encodeURIComponent(loaderId)}`;

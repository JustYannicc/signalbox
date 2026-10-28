import type { ProcessFence } from "../processOwnership/fence.ts";
import {
  fenceHistoryKey,
  readProcessFence,
  receiverFenceKey,
  sameProcessFence,
} from "../processOwnership/fence.ts";
import type {
  HarnessProcessEvictedRecoveryReceipt,
  HarnessProcessPlacementRecoveryRecord,
} from "./contracts.ts";
import {
  EVICTED_RECOVERY_PREFIX,
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  sameEvictedRecoveryReceipt,
  sameWriter,
  writerIdentityKey,
  type HarnessProcessPlacementWriter,
} from "./storeSchema.ts";

export const CLAIM_PREFIX = "proof/placement-writer-claim/v1/";
export interface PlacementWriterClaim {
  readonly owner: string;
  readonly previous: HarnessProcessPlacementWriter;
  readonly writer: HarnessProcessPlacementWriter;
  readonly fence: ProcessFence;
  readonly retirements: readonly (readonly [string, HarnessProcessEvictedRecoveryReceipt])[];
}
const claimKey = (owner: string, writer: HarnessProcessPlacementWriter) =>
  `${CLAIM_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(writerIdentityKey(writer))}`;

export async function observePlacementWriterClaim(
  transaction: DurableObjectTransaction,
  owner: string,
  previous: HarnessProcessPlacementWriter | undefined,
  writer: HarnessProcessPlacementWriter,
) {
  if (previous === undefined) return;
  const fence = readProcessFence(await transaction.get(receiverFenceKey(owner)));
  if (fence.owner !== owner || fence.nonce !== writer.shardIncarnationNonce)
    throw new Error("Observed writer claim has no exact receiver fence.");
  const retirements = [...(await transaction.list<unknown>({ prefix: EVICTED_RECOVERY_PREFIX }))]
    .map(([key, value]) => [key, parseEvictedRecoveryReceipt(value)] as const)
    .filter(([, receipt]) => receipt.state === "completed");
  await transaction.put(claimKey(owner, writer), { owner, previous, writer, fence, retirements });
}

export function followsPlacementWriterClaims(
  receiptKey: string,
  receipt: HarnessProcessEvictedRecoveryReceipt,
  writer: HarnessProcessPlacementWriter,
  fence: ProcessFence,
  claims: ReadonlyMap<string, PlacementWriterClaim> | undefined,
  history: ReadonlyMap<string, unknown>,
) {
  let nextWriter = writer;
  let nextFence = fence;
  const seen = new Set<string>();
  while (!sameWriter(nextWriter, receipt.currentWriter)) {
    const key = claimKey(receipt.owner, nextWriter);
    if (seen.has(key)) return false;
    seen.add(key);
    const claim = claims?.get(key);
    if (
      claim === undefined ||
      claim.owner !== receipt.owner ||
      !sameWriter(claim.writer, nextWriter) ||
      !sameProcessFence(claim.fence, nextFence) ||
      !claim.retirements.some(
        ([key, value]) => key === receiptKey && sameEvictedRecoveryReceipt(value, receipt),
      )
    )
      return false;
    const previousFences = [...history.values()].flatMap((value) => {
      const candidate = readProcessFence(value);
      return candidate.owner === receipt.owner &&
        candidate.nonce === claim.previous.shardIncarnationNonce
        ? [candidate]
        : [];
    });
    const previousFence = previousFences[0];
    if (
      previousFence === undefined ||
      previousFence.incarnation >= nextFence.incarnation ||
      !sameWriter(
        { ...claim.previous, shardIncarnationNonce: writer.shardIncarnationNonce },
        writer,
      ) ||
      !sameProcessFence(
        readProcessFence(history.get(fenceHistoryKey(nextFence.incarnation))),
        nextFence,
      )
    )
      return false;
    if (sameWriter(claim.previous, receipt.sourceWriter))
      return (
        sameProcessFence(previousFence, receipt.sourceFence) &&
        receiptKey === evictedRecoveryKey(receipt.owner, receipt.sourceFence, receipt.identity)
      );
    nextWriter = claim.previous;
    nextFence = previousFence;
  }
  return sameProcessFence(nextFence, receipt.currentFence);
}

export function isUnopenedPlacement(record: HarnessProcessPlacementRecoveryRecord) {
  return (
    record.state === "unopened" &&
    record.identityState === "unknown" &&
    record.incarnationNonce === undefined &&
    record.publicationState === undefined &&
    record.publicationReceipt === undefined &&
    record.invocationMayHaveStarted === undefined &&
    record.invocationAttempt === undefined &&
    record.invocationRequestId === undefined &&
    record.invocationReply === undefined &&
    record.lastFailure === undefined &&
    record.terminalFailure === undefined &&
    !record.stopAcknowledged &&
    !record.joined.invocationRpc &&
    !record.joined.fetch &&
    !record.joined.ports
  );
}

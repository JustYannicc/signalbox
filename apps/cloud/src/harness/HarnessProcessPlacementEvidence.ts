export { placementReleaseEvidence, stopKey } from "./processPlacement/releaseEvidence.ts";
export type { PlacementReleaseEvidence } from "./processPlacement/releaseEvidence.ts";
export { selectPlacementReleaseProof } from "./processPlacement/releaseProof.ts";
export type {
  PlacementReleaseProof,
  ObservedPlacementRelease,
} from "./processPlacement/releaseProof.ts";
export { observePlacementWriterClaim } from "./processPlacement/releaseObservations.ts";
export {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  parseRecoveryRecord,
} from "./processPlacement/storeSchema.ts";

import type { ProcessSlotState } from "../computer/ProcessSlots.ts";
import { assertProcessFenceNonce, receiverFenceKey } from "./processOwnership/fence.ts";
import {
  EVICTED_RECOVERY_PREFIX,
  RECOVERY_PREFIX,
  STATE_KEY,
  type HarnessProcessPlacementWriter,
} from "./processPlacement/storeSchema.ts";
import {
  STOP_PREFIX,
  type PlacementReleaseEvidence,
  type PlacementStopReceipt,
} from "./processPlacement/releaseEvidence.ts";
import { CLAIM_PREFIX, type PlacementWriterClaim } from "./processPlacement/releaseObservations.ts";
import { selectPlacementReleaseProof } from "./processPlacement/releaseProof.ts";

export async function observePlacementRelease(
  storage: DurableObjectStorage,
  owner: string,
  writer: HarnessProcessPlacementWriter,
  readEvidence: () => Promise<PlacementReleaseEvidence>,
) {
  await storage.transaction((transaction) =>
    assertProcessFenceNonce(transaction, owner, writer.shardIncarnationNonce),
  );
  const evidence = await readEvidence();
  const proof = selectPlacementReleaseProof({
    owner,
    writer,
    evidence,
    retirements: await storage.list<unknown>({ prefix: EVICTED_RECOVERY_PREFIX }),
    receiverFence: await storage.get<unknown>(receiverFenceKey(owner)),
    slots: await storage.get<ProcessSlotState>(STATE_KEY),
    recoveryCount: (await storage.list({ prefix: RECOVERY_PREFIX })).size,
    stops: await storage.list<PlacementStopReceipt>({ prefix: STOP_PREFIX }),
    claims: await storage.list<PlacementWriterClaim>({ prefix: CLAIM_PREFIX }),
  });
  return { evidence, proof };
}

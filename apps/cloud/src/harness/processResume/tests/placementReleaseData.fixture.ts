import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
import {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
  type PlacementReleaseEvidence,
} from "../../HarnessProcessPlacementEvidence.ts";

export function retirement() {
  const owner = "placement-owner";
  const sourceFence = { owner, incarnation: 2, nonce: "destroyed-parent" };
  const currentFence = { owner, incarnation: 3, nonce: "current-parent" };
  const sourceWriter = {
    executionOperationId: "cold-create",
    shardIndex: 0,
    shardIncarnationNonce: sourceFence.nonce,
    controllerClaim: {
      ownerId: "owner",
      incarnationId: "controller-2",
      epoch: 2,
      controlKey: "key",
    },
  };
  const writer = { ...sourceWriter, shardIncarnationNonce: currentFence.nonce };
  const receipt = parseEvictedRecoveryReceipt({
    version: 1,
    owner,
    sourceFence,
    currentFence,
    sourceWriter,
    currentWriter: writer,
    processId: "native-process",
    identity: {
      shardOwner: owner,
      loaderId: "facet",
      facetKey: "facet",
      incarnationNonce: "published-facet",
    },
    lease: { loaderId: "facet", token: "lease", codeId: "code", residentBytes: 1 },
    state: "completed",
  });
  const evidence: PlacementReleaseEvidence = {
    terminal: [],
    terminalOwners: [],
    sources: [
      {
        owner,
        sourceFence,
        sourceWriter,
        processId: receipt.processId,
        identity: receipt.identity,
      },
    ],
    fences: [
      ["harness-process-incarnation/v1/current", currentFence],
      ["harness-process-incarnation/v1/history/2", sourceFence],
      ["harness-process-incarnation/v1/history/3", currentFence],
    ],
  };
  const slots: ProcessSlotState = { version: 1, owner, lost: 1, slots: [] };
  return {
    owner,
    writer,
    evidence,
    receipt,
    retirements: new Map<string, unknown>([
      [evictedRecoveryKey(owner, sourceFence, receipt.identity), receipt],
    ]),
    receiverFence: currentFence,
    slots,
    recoveryCount: 0,
  };
}

import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
import { expect, it, vi } from "vite-plus/test";
import {
  selectPlacementReleaseProof,
  type PlacementReleaseEvidence,
} from "./placementReleaseObserver.fixture.ts";
import {
  evictedRecoveryKey,
  parseEvictedRecoveryReceipt,
} from "../../processPlacement/storeSchema.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: Object }));

function retirement() {
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

it("accepts completed destruction retirement without inventing a graceful stop", () => {
  const input = retirement();
  expect(selectPlacementReleaseProof(input)).toEqual({
    kind: "parent-destroyed",
    receipt: input.receipt,
    terminals: [],
  });
});

it.each([
  [
    "unfinished retirement",
    (input: ReturnType<typeof retirement>) => {
      input.retirements.set([...input.retirements.keys()][0]!, {
        ...input.receipt,
        state: "authorized",
      });
    },
  ],
  [
    "another writer",
    (input: ReturnType<typeof retirement>) => {
      input.writer = { ...input.writer, executionOperationId: "different" };
    },
  ],
  [
    "another controller",
    (input: ReturnType<typeof retirement>) => {
      input.writer = {
        ...input.writer,
        controllerClaim: { ...input.writer.controllerClaim, epoch: 3 },
      };
    },
  ],
  [
    "forged identity",
    (input: ReturnType<typeof retirement>) => {
      input.retirements.set([...input.retirements.keys()][0]!, {
        ...input.receipt,
        identity: { ...input.receipt.identity, incarnationNonce: "forged" },
      });
    },
  ],
  [
    "forged source fence",
    (input: ReturnType<typeof retirement>) => {
      input.retirements.set([...input.retirements.keys()][0]!, {
        ...input.receipt,
        sourceFence: { ...input.receipt.sourceFence, nonce: "forged" },
        sourceWriter: { ...input.receipt.sourceWriter, shardIncarnationNonce: "forged" },
      });
    },
  ],
  [
    "stale receiver",
    (input: ReturnType<typeof retirement>) => {
      input.receiverFence = { ...input.receiverFence, nonce: "other" };
    },
  ],
  [
    "unremoved recovery",
    (input: ReturnType<typeof retirement>) => {
      input.recoveryCount = 1;
    },
  ],
  [
    "wrong slot owner",
    (input: ReturnType<typeof retirement>) => {
      input.slots = { ...input.slots, owner: "other-owner" };
    },
  ],
  [
    "held lease",
    (input: ReturnType<typeof retirement>) => {
      input.slots = {
        ...input.slots,
        slots: [
          {
            codeId: "code",
            index: 0,
            generation: 1,
            holder: { token: input.receipt.lease.token, residentBytes: 1, permitted: false },
          },
        ],
      };
    },
  ],
  [
    "missing durable source",
    (input: ReturnType<typeof retirement>) => {
      input.evidence.sources = [];
    },
  ],
])("rejects %s", (_name, mutate) => {
  const input = retirement();
  mutate(input);
  expect(() => selectPlacementReleaseProof(input)).toThrow();
});

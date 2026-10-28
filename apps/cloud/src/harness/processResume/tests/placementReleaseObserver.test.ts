import { expect, it, vi } from "vite-plus/test";
import {
  selectPlacementReleaseProof,
  ObservedPlacementStore,
} from "./placementReleaseObserver.fixture.ts";
import { parseRecoveryRecord } from "../../HarnessProcessPlacementEvidence.ts";

import { retirement } from "./placementReleaseData.fixture.ts";
import { durableRootContext } from "../../tests/processIncarnation/durableRootFixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

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

it.each(["unpublished", "invoked", "unjoined"] as const)(
  "observes real placement stop/join before releasing an %s candidate",
  async (scenario) => {
    const input = retirement();
    const durable = durableRootContext(input.owner);
    const record = parseRecoveryRecord(
      {
        version: 1,
        shardOwner: input.owner,
        controllerClaim: input.writer.controllerClaim,
        operationId: "prepare",
        processId: "native-process",
        nativeSessionId: "session",
        checkpointId: "checkpoint",
        manifestRevision: "manifest",
        priorFacetNonce: "prior",
        programCodeId: "code",
        loaderId: "facet",
        facetKey: "facet",
        identityState: "observed",
        incarnationNonce: "inert-facet",
        lease: input.receipt.lease,
        state: "prepared",
        stopAcknowledged: true,
        joined: { invocationRpc: true, fetch: true, ports: scenario !== "unjoined" },
        invocationMayHaveStarted: scenario === "invoked",
      },
      input.owner,
    );
    const store = new ObservedPlacementStore(
      durable.context as unknown as DurableObjectState,
      {
        PROCESS_EXECUTION_SHARDS: {
          getByName: () => ({
            executionIncarnationNonce: async () => input.writer.shardIncarnationNonce,
            placementReleaseEvidence: async () => input.evidence,
          }),
        },
      } as unknown as ConstructorParameters<typeof ObservedPlacementStore>[1],
    );
    try {
      await store.claimProcessFence(input.receiverFence);
      await store.claimWriter(input.owner, input.writer);
      await durable.storage.put("harness-process-slots-v1", input.slots);
      await store.saveRecovery(input.owner, input.writer, record);
      await expect(store.releaseWriter(input.owner, input.writer)).rejects.toThrow(
        "held slots or recovery",
      );
      await store.removeRecovery(input.owner, input.writer, record.loaderId);
      if (scenario === "unpublished") {
        await store.releaseWriter(input.owner, input.writer);
        expect(await store.writerReleased(input.owner, input.writer)).toBe(true);
        expect(await store.readWriter(input.owner)).toBeUndefined();
      } else {
        await expect(store.releaseWriter(input.owner, input.writer)).rejects.toThrow();
        expect(await store.readWriter(input.owner)).toEqual(input.writer);
      }
      expect(await durable.storage.list({ prefix: "harness-process-terminal/" })).toEqual(
        new Map(),
      );
    } finally {
      durable.close();
    }
  },
);

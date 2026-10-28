import { expect, it, vi } from "vite-plus/test";
import { parseRecoveryRecord } from "../../HarnessProcessPlacementEvidence.ts";
import { ObservedPlacementStore } from "./placementReleaseObserver.fixture.ts";
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

it("keeps unopened cleanup recoverable if its proof write fails after deletion", async () => {
  const input = retirement();
  const durable = durableRootContext(input.owner);
  let failProof = true;
  const events: string[] = [];
  const stopPrefix = "proof/placement-stop/v1/";
  function checkWrite(key: string | Record<string, unknown>) {
    if (typeof key === "string" && key.startsWith(stopPrefix)) {
      events.push("proof-write");
      if (failProof) throw new Error("crash before cleanup proof commit");
    }
  }
  const storage: typeof durable.storage = {
    ...durable.storage,
    put(key, value) {
      checkWrite(key);
      return durable.storage.put(key, value);
    },
    transaction(operation) {
      return durable.storage.transaction((transaction) =>
        operation({
          ...transaction,
          async put(key, value) {
            checkWrite(key);
            return transaction.put(key, value);
          },
          async delete(key) {
            events.push("delete");
            return transaction.delete(key);
          },
        }),
      );
    },
  };
  function reconstruct() {
    return new ObservedPlacementStore(
      { ...durable.context, storage } as unknown as DurableObjectState,
      {
        PROCESS_EXECUTION_SHARDS: {
          getByName: () => ({
            executionIncarnationNonce: async () => input.writer.shardIncarnationNonce,
            placementReleaseEvidence: async () => input.evidence,
          }),
        },
      } as unknown as ConstructorParameters<typeof ObservedPlacementStore>[1],
    );
  }
  const record = parseRecoveryRecord(
    {
      version: 1,
      shardOwner: input.owner,
      controllerClaim: input.writer.controllerClaim,
      operationId: "prepare",
      processId: "process",
      nativeSessionId: "session",
      checkpointId: "checkpoint",
      manifestRevision: "manifest",
      priorFacetNonce: "prior",
      programCodeId: "code",
      loaderId: "facet",
      facetKey: "facet",
      identityState: "unknown",
      lease: input.receipt.lease,
      state: "unopened",
      stopAcknowledged: false,
      joined: { invocationRpc: false, fetch: false, ports: false },
    },
    input.owner,
  );
  let store = reconstruct();
  try {
    await store.claimProcessFence(input.receiverFence);
    await store.claimWriter(input.owner, input.writer);
    await store.save(input.owner, input.writer, input.slots);
    await store.saveRecovery(input.owner, input.writer, record);
    await expect(store.removeRecovery(input.owner, input.writer, record.loaderId)).rejects.toThrow(
      "crash before cleanup proof commit",
    );
    expect(events).toEqual(["delete", "proof-write"]);
    expect(await store.listRecovery(input.owner, input.writer)).toEqual([record]);
    expect(await durable.storage.list({ prefix: stopPrefix })).toEqual(new Map());
    expect(await store.readWriter(input.owner)).toEqual(input.writer);
    failProof = false;
    store = reconstruct();
    await store.removeRecovery(input.owner, input.writer, record.loaderId);
    expect(await store.listRecovery(input.owner, input.writer)).toEqual([]);
    expect((await durable.storage.list({ prefix: stopPrefix })).size).toBe(1);
    store = reconstruct();
    await store.removeRecovery(input.owner, input.writer, record.loaderId);
    await store.releaseWriter(input.owner, input.writer);
    expect(await store.writerReleased(input.owner, input.writer)).toBe(true);
    expect(await store.readWriter(input.owner)).toBeUndefined();
    expect(await durable.storage.list({ prefix: "harness-process-terminal/" })).toEqual(new Map());
  } finally {
    durable.close();
  }
});

import { expect, it, vi } from "vite-plus/test";
import {
  createHarnessProcessPlacement,
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementRecoveryRecord,
} from "../../HarnessProcessPlacement.ts";
import {
  placementReleaseEvidence,
  evictedRecoveryKey,
} from "../../HarnessProcessPlacementEvidence.ts";
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

function fixture() {
  const input = retirement();
  const durable = durableRootContext(input.owner);
  let nonce = input.writer.shardIncarnationNonce;
  const store = new ObservedPlacementStore(
    durable.context as unknown as DurableObjectState,
    {
      PROCESS_EXECUTION_SHARDS: {
        getByName: () => ({
          executionIncarnationNonce: async () => nonce,
          placementReleaseEvidence: async () => input.evidence,
        }),
      },
    } as unknown as ConstructorParameters<typeof ObservedPlacementStore>[1],
  );
  return {
    input,
    durable,
    store,
    setNonce(value: string) {
      nonce = value;
    },
  };
}

it.each(["processId", "nativeSessionId"] as const)(
  "retains the writer when graceful terminal %s differs from durable ownership",
  async (field) => {
    const f = fixture();
    const { input, durable, store } = f;
    const terminal = {
      version: 1,
      runId: "run",
      processId: "process",
      processOperationId: "operation",
      nativeSessionId: "session",
      request: { requestId: "request" },
      publisher: { publisherId: "publisher" },
      control: input.writer.controllerClaim,
      placement: { owner: input.owner, ...input.writer },
      identity: input.receipt.identity,
      stopped: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
      acknowledgementId: "ack",
    };
    const key = "harness-process-terminal/v1/run/operation/request";
    const c = durableRootContext(input.owner);
    try {
      await c.storage.put(key, { ...terminal, [field]: "forged" });
      await c.storage.put("harness-owned-process/v1/run/operation/request", {
        terminalKey: key,
        runId: terminal.runId,
        process: {
          processId: terminal.processId,
          operationId: terminal.processOperationId,
          nativeSessionId: terminal.nativeSessionId,
        },
        request: terminal.request,
        publisher: terminal.publisher,
        identity: terminal.identity,
        placement: terminal.placement,
        control: terminal.control,
      });
      input.evidence = await placementReleaseEvidence(c.storage as unknown as DurableObjectStorage);
      await store.claimProcessFence(input.receiverFence);
      await store.claimWriter(input.owner, input.writer);
      await durable.storage.put("harness-process-slots-v1", input.slots);
      await expect(store.releaseWriter(input.owner, input.writer)).rejects.toThrow("not bound");
      expect(await store.readWriter(input.owner)).toEqual(input.writer);
      await c.storage.put(key, terminal);
      input.evidence = await placementReleaseEvidence(c.storage as unknown as DurableObjectStorage);
      await store.releaseWriter(input.owner, input.writer);
      expect(await store.writerReleased(input.owner, input.writer)).toBe(true);
    } finally {
      c.close();
      durable.close();
    }
  },
);

it.each(["construction", "identity"] as const)(
  "distinguishes %s failure before removing placement ownership",
  async (scenario) => {
    const { input, durable, store } = fixture();
    // The real allocator requires a namespaced owner.
    const owner = "placement/owner";
    const writer = input.writer;
    const removed: HarnessProcessPlacementRecoveryRecord[] = [];
    const identity = vi.fn(async () => {
      throw new Error("identity RPC failed");
    });
    const otherRpc = vi.fn(async () => {
      throw new Error("unexpected RPC");
    });
    try {
      await store.claimProcessFence({ ...input.receiverFence, owner });
      await store.claimWriter(owner, writer);
      const stores = createHarnessProcessPlacementStoreClient(store, owner, writer);
      const placement = await createHarnessProcessPlacement({
        owner,
        contextKey: {},
        context: "durable-object",
        shardIncarnationNonce: writer.shardIncarnationNonce,
        controllerClaim: writer.controllerClaim,
        residentByteLimit: 100,
        store: stores.processSlots,
        recovery: {
          list: () => stores.recovery.list(),
          save: (record) => stores.recovery.save(record),
          async remove(loaderId) {
            removed.push(...(await stores.recovery.list()));
            await stores.recovery.remove(loaderId);
          },
        },
        invalidate() {},
        reconcile: async () => ({ acknowledged: true }),
        scheduleQuantum(callback) {
          queueMicrotask(callback);
          return () => {};
        },
      });
      await expect(
        placement.prepareInert(
          {
            processId: "process",
            codeId: "code",
            residentBytes: 1,
            nativeSessionId: "session",
            checkpointId: "checkpoint",
            manifestRevision: "manifest",
            priorFacetNonce: "prior",
            controllerClaim: writer.controllerClaim,
            operationId: "operation",
            expectedFacetGeneration: 1,
            signal: new AbortController().signal,
          },
          () => {
            if (scenario === "construction") throw new Error("stub construction failed");
            return {
              identity,
              prepareInert: otherRpc,
              activate: otherRpc,
              invoke: otherRpc,
              stop: otherRpc,
              join: otherRpc,
              dispose: otherRpc,
            };
          },
        ),
      ).rejects.toThrow(scenario === "construction" ? "before any RPC" : "identity RPC");
      expect(otherRpc).not.toHaveBeenCalled();
      if (scenario === "identity") {
        expect(identity).toHaveBeenCalledOnce();
        expect(removed).toHaveLength(0);
        await expect(store.releaseWriter(owner, writer)).rejects.toThrow("held slots or recovery");
        expect(await store.readWriter(owner)).toEqual(writer);
        return;
      }
      expect(identity).not.toHaveBeenCalled();
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({
        state: "unopened",
        stopAcknowledged: false,
        joined: { invocationRpc: false, fetch: false, ports: false },
      });
      await store.releaseWriter(owner, writer);
      expect(await store.writerReleased(owner, writer)).toBe(true);
    } finally {
      durable.close();
    }
  },
);

it.each([1, 2])(
  "reclaims completed retirement through %i later parent incarnation(s)",
  async (count) => {
    const f = fixture();
    const { input, durable, store } = f;
    try {
      await store.claimProcessFence(input.receiverFence);
      await store.claimWriter(input.owner, input.writer);
      await durable.storage.put("harness-process-slots-v1", input.slots);
      for (const [key, receipt] of input.retirements) await durable.storage.put(key, receipt);
      let writer = input.writer;
      for (let offset = 1; offset <= count; offset++) {
        const fence = {
          ...input.receiverFence,
          incarnation: input.receiverFence.incarnation + offset,
          nonce: `restarted-${offset}`,
        };
        f.setNonce(fence.nonce);
        writer = { ...input.writer, shardIncarnationNonce: fence.nonce };
        input.evidence.fences.push([
          `harness-process-incarnation/v1/history/${fence.incarnation}`,
          fence,
        ]);
        input.evidence.fences[0] = ["harness-process-incarnation/v1/current", fence];
        await store.claimProcessFence(fence);
        await store.claimWriter(input.owner, writer);
      }
      const claims = await durable.storage.list({ prefix: "proof/placement-writer-claim/v1/" });
      const claimKey = [...claims.keys()][0]!;
      await durable.storage.delete(claimKey);
      await expect(store.releaseWriter(input.owner, writer)).rejects.toThrow("no unique exact");
      expect(await store.readWriter(input.owner)).toEqual(writer);
      await durable.storage.put(claimKey, claims.get(claimKey));
      const key = evictedRecoveryKey(
        input.owner,
        input.receipt.sourceFence,
        input.receipt.identity,
      );
      await durable.storage.put(key, { ...input.receipt, processId: "forged" });
      await expect(store.releaseWriter(input.owner, writer)).rejects.toThrow("no unique exact");
      expect(await store.readWriter(input.owner)).toEqual(writer);
      await durable.storage.put(key, input.receipt);
      await store.releaseWriter(input.owner, writer);
      expect(await store.writerReleased(input.owner, writer)).toBe(true);
    } finally {
      durable.close();
    }
  },
);

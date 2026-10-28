import { expect, it, vi } from "vite-plus/test";
import { ProofPlacementStore } from "./publicResumeShard.fixture.ts";
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
  RpcTarget: Object,
  WorkerEntrypoint: Object,
}));

it("observes retained placement after reconstruction without borrowing its stale writer", async () => {
  const durable = durableRootContext("observation-owner");
  const owner = "observation-owner";
  const writer = {
    executionOperationId: "operation",
    shardIndex: 0,
    shardIncarnationNonce: "old-nonce",
    controllerClaim: {
      ownerId: "owner",
      incarnationId: "controller",
      epoch: 1,
      controlKey: "controller-key-".repeat(3),
    },
  };
  const store = new ProofPlacementStore(
    durable.context as unknown as DurableObjectState,
    {
      PROCESS_EXECUTION_SHARDS: {
        getByName: () => ({ executionIncarnationNonce: async () => "old-nonce" }),
      },
    } as unknown as ConstructorParameters<typeof ProofPlacementStore>[1],
  );
  const state = {
    version: 1 as const,
    owner,
    lost: 0,
    slots: [
      {
        codeId: "release",
        index: 0,
        generation: 1,
        holder: { token: "lease", residentBytes: 1, permitted: true },
      },
    ],
  };
  try {
    await store.claimProcessFence({ owner, incarnation: 1, nonce: "old-nonce" });
    await store.claimWriter(owner, writer);
    await durable.storage.put("harness-process-slots-v1", state);
    const persisted = await store.load(owner, writer);
    if (persisted === undefined) throw new Error("Missing seeded slots.");
    await store.claimProcessFence({ owner, incarnation: 2, nonce: "new-nonce" });
    const before = await durable.storage.list();
    await expect(store.ownership(owner)).resolves.toEqual({
      writer: true,
      leases: 1,
      permits: 1,
      records: [],
    });
    await expect(store.save(owner, writer, persisted)).rejects.toThrow(
      "stale process-shard incarnation",
    );
    expect(await store.staleWriterRefused(owner)).toBe(true);
    expect(await durable.storage.list()).toEqual(before);
  } finally {
    durable.close();
  }
});

import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessProcessPlacementStoreObject } from "../HarnessProcessPlacementStoreObject.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";

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

it("refuses an old writer's claim even when its delayed live-nonce RPC reports the old actor", async () => {
  const durable = durableRootContext("execution-shard");
  let nonce = "first-nonce";
  const environment = {
    PROCESS_EXECUTION_SHARDS: {
      getByName: () => ({
        async executionIncarnationNonce() {
          return nonce;
        },
      }),
    },
  };
  const state = durable.context as unknown as DurableObjectState;
  const env = environment as unknown as ConstructorParameters<
    typeof HarnessProcessPlacementStoreObject
  >[1];
  const original = new HarnessProcessPlacementStoreObject(state, env);
  const fence = { owner: "execution-shard", incarnation: 1, nonce };
  const writer = {
    executionOperationId: "execution-one",
    shardIndex: 0,
    shardIncarnationNonce: nonce,
    controllerClaim: {
      ownerId: "owner",
      incarnationId: "controller",
      epoch: 1,
      controlKey: "controller-secret-".repeat(3),
    },
  };
  try {
    await original.claimProcessFence(fence);
    await original.claimWriter(fence.owner, writer);
    await original.claimProcessFence({ ...fence, incarnation: 2, nonce: "second-nonce" });
    const reconstructedStore = new HarnessProcessPlacementStoreObject(state, env);
    await expect(reconstructedStore.claimWriter(fence.owner, writer)).rejects.toThrow(
      "stale process-shard incarnation",
    );
    await expect(original.releaseWriter(fence.owner, writer)).rejects.toThrow(
      "stale process-shard incarnation",
    );
    nonce = "second-nonce";
    const currentWriter = { ...writer, shardIncarnationNonce: nonce };
    await reconstructedStore.claimWriter(fence.owner, currentWriter);
    expect(await reconstructedStore.readWriter(fence.owner)).toEqual(currentWriter);
    await expect(original.releaseWriter(fence.owner, writer)).rejects.toThrow();
    expect(await reconstructedStore.readWriter(fence.owner)).toEqual(currentWriter);
  } finally {
    durable.close();
  }
});

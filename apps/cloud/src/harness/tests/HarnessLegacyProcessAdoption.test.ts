import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessProcessExecutionShardObject } from "../HarnessProcessExecutionShardObject.ts";
import type { HarnessProcessExecutionEnvironment } from "../HarnessProcessPlacement.ts";
import { readHarnessRunStoreProcessSource } from "../HarnessRunStore.ts";
import { createLegacyAdoptionFixture } from "../processOwnership/tests/legacyProcessSource/HarnessLegacyProcessSource.fixture.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";
import { resumeOperation } from "./processIncarnation/resumeSourceFixture.ts";

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
}));

const closures: (() => void)[] = [];
afterEach(() => {
  for (const close of closures.splice(0)) close();
});

async function legacyShard() {
  const legacy = await createLegacyAdoptionFixture();
  const root = durableRootContext(legacy.terminal.placement.owner);
  closures.push(
    () => legacy.runStore.close(),
    () => root.close(),
  );
  const storage = root.storage as unknown as DurableObjectStorage;
  for (const [key, value] of legacy.values) await storage.put(key, value);
  const operation = {
    ...resumeOperation,
    ...legacy.operation,
    transition: {
      ...resumeOperation.transition,
      ...legacy.operation.transition,
      operationId: legacy.operation.runStore.transitionOperationId,
      expectedFacetGeneration: legacy.operation.runStore.currentPublisher.generation,
      nextControl: {
        ...legacy.operation.transition.control,
        epoch: legacy.operation.transition.control.epoch + 1,
        incarnationId: "replacement-controller",
        controlKey: "replacement-controller-key-".repeat(2),
      },
    },
    facet: { ...resumeOperation.facet, processId: legacy.operation.previousProcessId },
  };
  let authorityReads = 0;
  const supervisor = {
    async claimProcessFence() {},
    async execute() {
      if (++authorityReads > 1) throw new Error("Injected post-adoption authority failure.");
      return legacy.completion.supervisor;
    },
  };
  const journal = {
    async claimProcessFence() {},
    async execute() {},
    readProcessSource(auth: unknown) {
      return readHarnessRunStoreProcessSource(legacy.runStore.database, operation.runId, auth);
    },
  };
  const environment = {
    HARNESS_RUN_STORE: { getByName: () => journal },
    HARNESS_FILES_STORE: { getByName: () => ({ async claimProcessFence() {} }) },
    HARNESS_THREAD_SUPERVISOR: { getByName: () => supervisor },
    PLACEMENT_STORES: { getByName: () => ({ async claimProcessFence() {} }) },
  } as unknown as HarnessProcessExecutionEnvironment;
  const reconstruct = () =>
    new HarnessProcessExecutionShardObject(
      root.context as unknown as DurableObjectState,
      environment,
    );
  return { legacy, storage, operation, reconstruct, authorityReads: () => authorityReads };
}

it("adopts exact pre-upgrade receipts through C and refuses the reserved source after another reconstruction", async () => {
  const fixture = await legacyShard();
  const shard = fixture.reconstruct();
  await shard.executionIncarnationNonce();
  await expect(shard.resumeProcess(fixture.operation)).rejects.toThrow(
    "Injected post-adoption authority failure.",
  );
  const records = await fixture.storage.list({ prefix: "harness-owned-process/v1/" });
  const owned = [...records.values()].find((value) => typeof value === "object");
  expect(owned).toMatchObject({
    process: { processId: fixture.operation.previousProcessId },
    placement: { shardIncarnationNonce: "old-shard-incarnation-nonce" },
    fence: { incarnation: 1 },
    legacySource: { terminalKey: fixture.legacy.terminalKey },
    resumeClaim: { operationId: fixture.operation.transition.operationId },
  });
  const reconstructed = fixture.reconstruct();
  await reconstructed.executionIncarnationNonce();
  await expect(reconstructed.resumeProcess(fixture.operation)).rejects.toThrow(
    "source step already has a resume reservation",
  );
  expect(fixture.authorityReads()).toBe(2);
});

it("does not create ownership when a legacy terminal receipt is missing", async () => {
  const fixture = await legacyShard();
  await fixture.storage.delete(fixture.legacy.terminalKey);
  const shard = fixture.reconstruct();
  await shard.executionIncarnationNonce();
  await expect(shard.resumeProcess(fixture.operation)).rejects.toThrow(
    "exact terminal receipt is missing",
  );
  expect((await fixture.storage.list({ prefix: "harness-owned-process/v1/" })).size).toBe(0);
  expect(fixture.authorityReads()).toBe(0);
});

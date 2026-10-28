import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessProcessExecutionShardObject } from "../HarnessProcessExecutionShardObject.ts";
import { HarnessProcessIncarnation } from "../HarnessProcessIncarnation.ts";
import type { HarnessProcessExecutionEnvironment } from "../HarnessProcessPlacement.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";
import { resumeOperation, seedResumeSource } from "./processIncarnation/resumeSourceFixture.ts";
import type { HarnessProcessResumeOperationInput } from "../HarnessProcessResume.ts";

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

const contexts: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.close();
});

const invalidSources: readonly {
  readonly name: string;
  readonly change: (
    operation: HarnessProcessResumeOperationInput,
  ) => HarnessProcessResumeOperationInput;
}[] = [
  {
    name: "input bytes",
    change: (operation) => ({
      ...operation,
      runStore: {
        ...operation.runStore,
        request: {
          ...operation.runStore.request,
          input: { ...operation.runStore.request.input, sha256: "b".repeat(64) },
        },
      },
    }),
  },
  {
    name: "initial filesystem hash",
    change: (operation) => ({
      ...operation,
      runStore: {
        ...operation.runStore,
        checkpoint: {
          ...operation.runStore.checkpoint,
          filesystem: { ...operation.runStore.checkpoint.filesystem, sha256: "b".repeat(64) },
        },
      },
    }),
  },
  {
    name: "initial native hash",
    change: (operation) => ({
      ...operation,
      runStore: {
        ...operation.runStore,
        checkpoint: {
          ...operation.runStore.checkpoint,
          native: { ...operation.runStore.checkpoint.native, sha256: "b".repeat(64) },
        },
      },
    }),
  },
  {
    name: "request publisher",
    change: (operation) => ({
      ...operation,
      runStore: {
        ...operation.runStore,
        currentPublisher: {
          ...operation.runStore.currentPublisher,
          publisherKey: "different-publisher-".repeat(2),
        },
      },
    }),
  },
  {
    name: "A publisher",
    change: (operation) => ({
      ...operation,
      transition: {
        ...operation.transition,
        publisher: {
          ...operation.transition.publisher,
          publisherKey: "different-publisher-".repeat(2),
        },
      },
    }),
  },
  {
    name: "controller",
    change: (operation) => ({
      ...operation,
      transition: {
        ...operation.transition,
        control: { ...operation.transition.control, controlKey: "different-controller-".repeat(2) },
      },
    }),
  },
];

it.each(invalidSources)(
  "refuses changed $name against the durable source before any authority write",
  async ({ change }) => {
    const fixture = durableRootContext("execution-shard");
    contexts.push(fixture);
    const storage = fixture.storage as unknown as DurableObjectStorage;
    const origin = new HarnessProcessIncarnation(storage, "execution-shard", "origin-nonce");
    const ownedKey = await seedResumeSource(storage, await origin.ready);
    const untouched = await storage.get(ownedKey);
    const execute = vi.fn(async (_command: unknown) => undefined);
    const store = { async claimProcessFence() {}, execute };
    const namespace = { getByName: () => store };
    const environment = {
      HARNESS_RUN_STORE: namespace,
      HARNESS_FILES_STORE: namespace,
      HARNESS_THREAD_SUPERVISOR: namespace,
      PLACEMENT_STORES: namespace,
    } as unknown as HarnessProcessExecutionEnvironment;
    const shard = new HarnessProcessExecutionShardObject(
      fixture.context as unknown as DurableObjectState,
      environment,
    );
    await shard.executionIncarnationNonce();
    await expect(shard.resumeProcess(change(resumeOperation))).rejects.toThrow(
      "exact durable owned process",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ type: "read", runId: resumeOperation.runId });
    expect(await storage.get(ownedKey)).toEqual(untouched);
  },
);

it("reads the durable source after reconstruction and refuses the same source step in another incarnation", async () => {
  const fixture = durableRootContext("execution-shard");
  contexts.push(fixture);
  const storage = fixture.storage as unknown as DurableObjectStorage;
  const origin = new HarnessProcessIncarnation(storage, "execution-shard", "origin-nonce");
  const fence = await origin.ready;
  const ownedKey = await seedResumeSource(storage, fence);
  let authorizationReads = 0;
  const supervisor = {
    async claimProcessFence() {},
    async execute() {
      authorizationReads++;
      throw new Error("Injected unavailable current A authority.");
    },
  };
  const readOnlyJournal = { async claimProcessFence() {}, async execute() {} };
  const environment = {
    HARNESS_THREAD_SUPERVISOR: { getByName: () => supervisor },
    HARNESS_RUN_STORE: { getByName: () => readOnlyJournal },
    HARNESS_FILES_STORE: { getByName: () => readOnlyJournal },
    PLACEMENT_STORES: { getByName: () => ({ async claimProcessFence() {} }) },
  } as unknown as HarnessProcessExecutionEnvironment;
  const reconstructed = new HarnessProcessExecutionShardObject(
    fixture.context as unknown as DurableObjectState,
    environment,
  );
  await reconstructed.executionIncarnationNonce();
  await expect(reconstructed.resumeProcess(resumeOperation)).rejects.toThrow(
    "Injected unavailable current A authority.",
  );
  expect(authorizationReads).toBe(1);
  expect(await storage.get(ownedKey)).toMatchObject({
    resumeClaim: { operationId: "resume-one", fence: { incarnation: 2 } },
  });

  const third = new HarnessProcessExecutionShardObject(
    fixture.context as unknown as DurableObjectState,
    environment,
  );
  await third.executionIncarnationNonce();
  await expect(third.resumeProcess(resumeOperation)).rejects.toThrow(
    "source step already has a resume reservation",
  );
  expect(authorizationReads).toBe(1);
  expect(await storage.get(ownedKey)).toMatchObject({
    resumeClaim: { operationId: "resume-one", fence: { incarnation: 2 } },
  });
});

import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessProcessExecutionShardObject } from "../HarnessProcessExecutionShardObject.ts";
import type { HarnessProcessExecutionEnvironment } from "../HarnessProcessPlacement.ts";
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
const roots: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
});

it("reacquires A's namespace stub after A reconstruction while preserving the C incarnation", async () => {
  const root = durableRootContext("shard");
  roots.push(root);
  let supervisorIncarnation = 1;
  const supervisor = {
    getByName() {
      const captured = supervisorIncarnation;
      return {
        async claimProcessFence() {},
        async execute() {
          if (captured !== supervisorIncarnation)
            throw new Error("A stub was broken by reconstruction.");
        },
      };
    },
  };
  const store = { getByName: () => ({ async claimProcessFence() {}, async execute() {} }) };
  const shard = new HarnessProcessExecutionShardObject(
    root.context as unknown as DurableObjectState,
    {
      HARNESS_THREAD_SUPERVISOR: supervisor,
      HARNESS_RUN_STORE: store,
      HARNESS_FILES_STORE: store,
      PLACEMENT_STORES: store,
    } as unknown as HarnessProcessExecutionEnvironment,
  );
  const nonce = await shard.executionIncarnationNonce();
  const input = {
    runId: "run",
    operationId: "resume",
    control: {
      ownerId: "owner",
      incarnationId: "controller",
      epoch: 1,
      controlKey: "key-".repeat(12),
    },
  };
  expect(await shard.processResumeStatus(input)).toEqual({ status: "missing" });
  supervisorIncarnation++;
  expect(await shard.processResumeStatus(input)).toEqual({ status: "missing" });
  expect(await shard.executionIncarnationNonce()).toBe(nonce);
});

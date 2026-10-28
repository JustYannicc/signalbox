import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HarnessProcessStoreBinding } from "../HarnessProcessStoreBinding.ts";
import { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
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
  WorkerEntrypoint: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const fixtures: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

it("keeps a facet's sealed fence after reconstruction and refuses token replacement by its caller", async () => {
  const fixture = durableRootContext("binding-run");
  fixtures.push(fixture);
  const files = new HarnessFilesStoreObject(fixture.context as unknown as DurableObjectState, {});
  const oldFence = { owner: "shard", incarnation: 1, nonce: "one" };
  const currentFence = { owner: "shard", incarnation: 2, nonce: "two" };
  const env = { HARNESS_FILES_STORE: { getByName: () => files } };
  const binding = (fence: typeof oldFence) =>
    new HarnessProcessStoreBinding(
      {
        props: { runId: "binding-run", store: "filesStore", fence },
      } as unknown as ExecutionContext,
      env as unknown as ConstructorParameters<typeof HarnessProcessStoreBinding>[1],
    );
  const old = binding(oldFence);
  await files.claimProcessFence(oldFence);
  const command = {
    type: "initialize",
    runId: "binding-run",
    control: {
      ownerId: "owner",
      incarnationId: "controller",
      epoch: 1,
      controlKey: "controller-key-".repeat(3),
    },
    publisher: { generation: 1, facetNonce: "facet", publisherKey: "publisher-key-".repeat(3) },
    checkpoint: { checkpointId: "initial", parentCheckpointId: null, files: [] },
  };
  await old.execute(command);
  await files.claimProcessFence(currentFence);
  const before = fixture.rows("SELECT revision,state_json FROM harness_files_meta");
  const spoofed = { ...command, fence: currentFence };
  await expect(old.execute(spoofed)).rejects.toThrow();
  await expect(Reflect.apply(old.execute, old, [command, currentFence])).rejects.toThrow();
  expect(fixture.rows("SELECT revision,state_json FROM harness_files_meta")).toEqual(before);
  const current = binding(currentFence);
  expect(await current.execute(command)).toMatchObject({ checkpoint: { checkpointId: "initial" } });
});

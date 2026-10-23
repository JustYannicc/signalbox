import { expect, it, vi } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { ChildBashExecutionGroup } from "../ChildBashExecutionGroup.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerRunner } from "../ChildWorkerProgram.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("keeps a fork killed before restore available for its parent's waitpid", async () => {
  const fixture = childBashFixture();
  const capacity = new ChildWorkerCapacity(1);
  const killed = { exitCode: 0, signal: 9, coreDumped: false };
  const runner = createChildWorkerRunner<KernelBashPort>({
    executable: "/bin/bash",
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    dispatch: { run: async () => killed },
  });
  const group = new ChildBashExecutionGroup(runner, runner, bashCredentials);
  const owner = createKernelBashHost({
    context: fixture.context,
    credentials: bashCredentials,
    runFork: (context, forkOwner, snapshot) => group.run(context, forkOwner, snapshot),
  });
  const restored = vi.fn(async () => {});
  const source: KernelBashForkSource = {
    async state() {
      return {
        version: 1,
        memoryBytes: 0,
        stackPointer: 0,
        continuation: { resume: 0 },
        captures: {
          stack: { low: 0, high: 0, log: 0 },
          base: 0,
          size: 0,
          names: [],
          stackNames: [],
          captures: [],
          top: 0,
          liveBytes: 0,
          nextId: 1,
          nextGeneration: 1,
        },
      };
    },
    read: async () => new Uint8Array(),
    restored,
  };
  try {
    const forked = await owner.port.fork();
    if (forked.kind !== "fork") throw new Error("The test fork could not start");
    expect(await forked.port.runFork(source)).toEqual(killed);
    expect(restored).not.toHaveBeenCalled();
    expect(await owner.port.wait(forked.pid, 0)).toEqual({
      kind: "wait",
      pid: forked.pid,
      status: killed,
    });
    await group.finish(owner.close);
    expect(capacity.active).toBe(0);
  } finally {
    await owner.close();
    await fixture.close();
  }
});

import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { createChildBashForkDispatch } from "../ChildBashForkDispatch.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const code = {
  mainModule: "main.js",
  modules: { "main.js": "export default {}" },
  freshIsolate: true,
};
const source: KernelBashForkSource = {
  state: async () => {
    throw new Error("The facet must not read the snapshot");
  },
  read: async () => {
    throw new Error("The facet must not copy the snapshot");
  },
  restored: async () => {},
};

describe("Bash fork dispatch", () => {
  it("queues against physical capacity without reading or copying the parent's snapshot", async () => {
    const fixture = childBashFixture();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 1 });
    const lifetimes = new ChildWorkerLifetimes();
    const permit = await capacity.acquire(fixture.controller.signal, undefined);
    const run = vi.fn(async (input: ChildWorkerInvocation, host: KernelBashPort) => {
      if (!("forkSnapshot" in host) || typeof host.forkSnapshot !== "function")
        throw new Error("Fork host has no snapshot capability");
      expect(input.freshIsolate).toBe(true);
      expect(host.forkSnapshot()).toBe(source);
      return exited(17);
    });
    const dispatch = createChildBashForkDispatch({
      credentials: bashCredentials,
      code,
      capacity,
      lifetimes,
      dispatch: { run },
    });
    try {
      const pending = dispatch(fixture.context, fixture.owner.port, source);
      expect(capacity.active).toBe(1);
      expect(run).not.toHaveBeenCalled();
      permit.release();
      expect(await pending).toEqual(exited(17));
      await lifetimes.drain();
      expect(capacity.active).toBe(0);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      permit.release();
      await fixture.close();
    }
  });

  it("reports a lost transport while keeping its physical permit until stop acknowledgement", async () => {
    const fixture = childBashFixture();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 1 });
    const lifetimes = new ChildWorkerLifetimes();
    const stopped = Promise.withResolvers<void>();
    let host: KernelBashPort | undefined;
    const failure = new ChildWorkerDispatchError(new Error("transport gone"), {
      kind: "unconfirmed",
      stopped: stopped.promise,
    });
    const dispatch = createChildBashForkDispatch({
      credentials: bashCredentials,
      code,
      capacity,
      lifetimes,
      dispatch: {
        async run(_input, supplied) {
          host = supplied;
          throw failure;
        },
      },
    });
    try {
      await expect(dispatch(fixture.context, fixture.owner.port, source)).rejects.toBe(failure);
      expect(capacity.active).toBe(1);
      await expect(
        host!.call({
          name: "args_sizes_get",
          args: [0, 4],
          memorySize: 8,
          regions: [{ pointer: 0, bytes: new Uint8Array(8) }],
        }),
      ).rejects.toMatchObject({ code: "EBADF" });
      stopped.resolve();
      await lifetimes.drain();
      expect(capacity.active).toBe(0);
    } finally {
      stopped.resolve();
      await lifetimes.drain();
      await fixture.close();
    }
  });
});

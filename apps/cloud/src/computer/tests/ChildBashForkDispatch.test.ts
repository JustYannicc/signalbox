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
      const pending = dispatch(
        fixture.context,
        { port: fixture.owner.port, close: async () => {} },
        source,
      );
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
      await expect(
        dispatch(fixture.context, { port: fixture.owner.port, close: async () => {} }, source),
      ).rejects.toBe(failure);
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

  it("closes the fork owner but retains capacity when an untyped transport failure has no stop ACK", async () => {
    const fixture = childBashFixture();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 1 });
    const lifetimes = new ChildWorkerLifetimes();
    const close = vi.fn(async () => {});
    const dispatch = createChildBashForkDispatch({
      credentials: bashCredentials,
      code,
      capacity,
      lifetimes,
      dispatch: {
        async run() {
          throw new Error("transport lost without ACK");
        },
      },
    });
    try {
      await expect(
        dispatch(fixture.context, { port: fixture.owner.port, close }, source),
      ).rejects.toMatchObject({
        code: "CLEANUP_UNCONFIRMED",
        message: "transport lost without ACK",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("captures modules and uses the fork's current umask while joining owner cleanup", async () => {
    const fixture = childBashFixture();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 1 });
    const lifetimes = new ChildWorkerLifetimes();
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const modules = { "main.js": { js: "original" } };
    fixture.filesystem.setUmask(0o077);
    const dispatch = createChildBashForkDispatch({
      credentials: bashCredentials,
      code: { ...code, modules },
      capacity,
      lifetimes,
      dispatch: {
        async run(input, host) {
          expect(input.modules["main.js"]).toEqual({ js: "original" });
          expect(
            "metadata" in host && typeof host.metadata === "function" ? host.metadata() : undefined,
          ).toMatchObject({
            credentials: { umask: 0o077 },
          });
          return exited(17);
        },
      },
    });
    modules["main.js"].js = "changed";
    try {
      const pending = dispatch(
        fixture.context,
        {
          port: fixture.owner.port,
          async close() {
            closing.resolve();
            await closed.promise;
          },
        },
        source,
      );
      await closing.promise;
      expect(capacity.active).toBe(1);
      closed.resolve();
      await expect(pending).resolves.toEqual(exited(17));
      await lifetimes.drain();
      expect(capacity.active).toBe(0);
    } finally {
      closed.resolve();
      await fixture.close();
    }
  });
});

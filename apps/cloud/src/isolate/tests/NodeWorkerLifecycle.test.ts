import * as NodeV8 from "node:v8";
import * as NodeWorkerThreads from "node:worker_threads";
import { describe, expect, it } from "vite-plus/test";
import {
  createNodeWorkerThreads,
  NodeWorkerPortBroker,
  type NodeWorkerExit,
} from "../NodeWorkerThreads.ts";

function controlledWorker(settleOnTerminate = true, beforeClose?: () => Promise<void>) {
  const broker = new NodeWorkerPortBroker();
  const watching = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<NodeWorkerExit>();
  let sequence = 0;
  const facade = createNodeWorkerThreads({
    moduleLoader: {
      reference: {
        artifactRef: "fixture:worker-lifecycle",
        artifactHash: "a".repeat(64),
        sourceIdentity: "fixture:worker-lifecycle",
      },
      resolve: () => "file:///fixtures/held-worker.mjs",
    },
    context: {
      ports: {
        owner: "lifecycle-main",
        connect: async (receiver) => {
          const connection = broker.connect("lifecycle-main", receiver);
          return {
            ...connection,
            close: async (address) => {
              await beforeClose?.();
              return connection.close(address);
            },
          };
        },
        disconnect: () => broker.disconnect("lifecycle-main"),
      },
      isMainThread: true,
      threadId: 0,
      env: {},
      argv: [],
      execArgv: [],
      allocateThreadId: () => ++sequence,
      output: async () => undefined,
    },
    supervisor: {
      start: async () => ({
        wait: () => {
          watching.resolve();
          return waiting.promise;
        },
        writeStdin: async () => undefined,
        terminate: async () => {
          const exit = { code: 1, stopped: true } as const;
          if (settleOnTerminate) waiting.resolve(exit);
          return exit;
        },
      }),
    },
  });
  return { facade, broker, watching, waiting };
}

describe("Node Worker facade lifetime", () => {
  it("keeps finishing bookkeeping off the guest Worker prototype", async () => {
    const h = controlledWorker();
    const metadata = (Worker: { readonly prototype: object }) =>
      JSON.stringify({
        hasRef: "hasRef" in Worker.prototype,
        blocksDrain: "blocksDrain" in Worker.prototype,
      });
    try {
      expect(metadata(h.facade.module.Worker)).toBe(metadata(NodeWorkerThreads.Worker));
    } finally {
      await h.facade.dispose();
      await h.broker.drain();
    }
  });

  it("joins exit finalization when terminate follows an acknowledged stop", async () => {
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = controlledWorker(true, async () => {
      closing.resolve();
      await release.promise;
    });
    const worker = new h.facade.module.Worker("held-worker.mjs");
    const order: string[] = [];
    worker.on("exit", () => order.push("exit"));
    try {
      await h.watching.promise;
      h.waiting.resolve({ code: 0, stopped: true });
      await closing.promise;
      const terminated = worker.terminate().then((code) => {
        order.push("terminate");
        return code;
      });
      await Promise.resolve();
      expect(order).toEqual([]);
      release.resolve();
      expect(await terminated).toBe(0);
      expect(order).toEqual(["exit", "terminate"]);
    } finally {
      release.resolve();
      await h.facade.dispose();
      await h.broker.drain();
    }
  });

  it("wakes an existing drain when its running Worker becomes unreferenced", async () => {
    const h = controlledWorker();
    const worker = new h.facade.module.Worker("held-worker.mjs");
    let drained = false;
    const firstDrain = h.facade.drain().then(() => {
      drained = true;
    });
    try {
      await h.watching.promise;
      worker.unref();
      await firstDrain;
      expect(h.facade.referenced).toBe(false);
      expect(worker.threadId).toBe(1);
      expect(drained).toBe(true);
    } finally {
      await worker.terminate();
      await firstDrain;
      await h.facade.dispose();
      await h.broker.drain();
    }
  });

  it("collects exited Workers while their parent facade stays alive", async () => {
    const h = controlledWorker();
    async function startAndStop() {
      const worker = new h.facade.module.Worker("held-worker.mjs", {
        workerData: new Uint8Array(1024),
        stdout: true,
      });
      await worker.terminate();
    }
    try {
      const before = NodeV8.queryObjects(h.facade.module.Worker, { format: "count" });
      await startAndStop();
      await startAndStop();
      await h.facade.drain();
      expect(NodeV8.queryObjects(h.facade.module.Worker, { format: "count" })).toBe(before);
    } finally {
      await h.facade.dispose();
      await h.broker.drain();
    }
  });

  it("fences a rejected old wait after termination acknowledged the guest stop", async () => {
    const h = controlledWorker(false);
    const worker = new h.facade.module.Worker("held-worker.mjs");
    const order: string[] = [];
    worker.on("error", () => order.push("error"));
    worker.on("exit", () => order.push("exit"));
    try {
      await h.watching.promise;
      expect(await worker.terminate()).toBe(1);
      h.waiting.reject(new Error("Old wait disconnected after confirmed stop"));
      await h.waiting.promise.catch(() => undefined);
      await h.facade.drain();
      expect(order).toEqual(["exit"]);
      expect(worker.threadId).toBe(-1);
    } finally {
      await h.facade.dispose();
      await h.broker.drain();
    }
  });
});

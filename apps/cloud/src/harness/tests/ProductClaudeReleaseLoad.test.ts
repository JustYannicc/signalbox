// @effect-diagnostics nodeBuiltinImport:off - The native personality needs an isolated Node realm.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it.each(["baseline", "sdk", "settings", "callback-only"])(
  "opens the catalog-selected Claude artifact for %s hook configuration",
  async (scenario) => {
    const worker = new NodeWorkerThreads.Worker(
      new URL("./productHost/releaseSelectionWorker.ts", import.meta.url),
      { workerData: scenario },
    );
    onTestFinished(async () => {
      await worker.terminate();
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Worker exited ${code}`));
      });
    });
    expect(result).toEqual({ ok: true });
  },
);

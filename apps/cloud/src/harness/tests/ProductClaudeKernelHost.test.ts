// @effect-diagnostics nodeBuiltinImport:off - The native personality must run in an isolated Node realm.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it.each([
  "turns",
  "cancel-prepare",
  "dispose-child",
  "no-machine",
  "failed-metadata",
  "cancel-child-leases",
])("keeps the product owners correct through %s", async (mode) => {
  const worker = new NodeWorkerThreads.Worker(
    new URL("./productHost/splitWorker.ts", import.meta.url),
    { workerData: mode },
  );
  onTestFinished(async () => {
    await worker.terminate();
  });
  const result = await new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Split product fixture exited ${code}`));
    });
  });
  expect(result).toEqual({ ok: true });
});

// @effect-diagnostics nodeBuiltinImport:off - The native personality needs an isolated Node realm.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it("publishes a Claude background continuation after settle and resumes buffered output", async () => {
  const worker = new NodeWorkerThreads.Worker(
    new URL("./productHost/continuationWorker.ts", import.meta.url),
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
});

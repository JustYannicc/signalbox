// @effect-diagnostics nodeBuiltinImport:off - The native personality owns an isolated Node realm.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it("provisions a checked local domain and preserves caller Opus 5.5 xhigh at native launch", async () => {
  const worker = new NodeWorkerThreads.Worker(
    new URL("./productHost/localDomainWorker.ts", import.meta.url),
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

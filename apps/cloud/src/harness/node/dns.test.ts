import * as NodeWorkerThreads from "node:worker_threads";
import { describe, it, onTestFinished } from "vite-plus/test";

describe("public Node harness DNS", () => {
  it.each([false, true])(
    "provides DNS with caller DNS = %s",
    (supplyDns) =>
      new Promise<void>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(
          new URL("./tests/dnsWorker.ts", import.meta.url),
          {
            workerData: supplyDns,
          },
        );
        onTestFinished(async () => {
          await worker.terminate();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`DNS worker exited with ${code}.`));
        });
      }),
  );
  it("disposal joins DNS and model transport cancellation", () =>
    new Promise<void>((resolve, reject) => {
      const worker = new NodeWorkerThreads.Worker(
        new URL("./tests/dnsCleanupWorker.ts", import.meta.url),
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no browser target origin.
      worker.on("message", () => worker.postMessage("settle DNS"));
      onTestFinished(async () => {
        await worker.terminate();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`DNS cleanup worker exited with ${code}.`));
      });
    }));
});

import * as NodeWorkerThreads from "node:worker_threads";
import { describe, it, onTestFinished } from "vite-plus/test";

describe("Node harness terminal detection", () => {
  it.each([false, true])(
    "installs guest tty with supplied native tty = %s",
    (supplyTty) =>
      new Promise<void>((resolve, reject) => {
        // The guest replaces process globals and may launch only once per realm.
        const worker = new NodeWorkerThreads.Worker(
          new URL("./tests/ttyWorker.ts", import.meta.url),
          {
            workerData: supplyTty,
          },
        );
        onTestFinished(async () => {
          await worker.terminate();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`TTY worker exited with ${code}.`));
        });
      }),
  );
});

describe("Node harness teardown", () => {
  it.each(["exit", "abort"])(
    "only calls a guest's replacement methods while the guest is installed, on %s",
    (mode) =>
      new Promise<void>((resolve, reject) => {
        // Teardown restores host globals, so a guest method running then would act as the host.
        const worker = new NodeWorkerThreads.Worker(
          new URL("./tests/teardownWorker.ts", import.meta.url),
          { workerData: mode },
        );
        onTestFinished(async () => {
          await worker.terminate();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Teardown worker exited with ${code}.`));
        });
      }),
  );
});

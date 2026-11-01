import * as NodeWorkerThreads from "node:worker_threads";
import { describe, it, onTestFinished } from "@effect/vitest";

describe("Node harness detached CLI startup failure", () => {
  it.each(["rejection", "exit", "late"] as const)(
    "keeps startup failure ownership for %s",
    (mode) =>
      new Promise<void>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(
          new URL("./tests/cliStartupFailureWorker.ts", import.meta.url),
          { workerData: mode },
        );
        onTestFinished(async () => {
          await worker.terminate();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`CLI startup failure worker exited with ${code}`));
        });
      }),
  );
});

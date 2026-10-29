import * as NodeWorkerThreads from "node:worker_threads";
import { describe, it, onTestFinished } from "@effect/vitest";

describe("Node harness child observation", () => {
  it.each(["success", "error", "observer-throws"])(
    "captures the normal child lifecycle without consuming output: %s",
    (mode) =>
      new Promise<void>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(
          new URL("./tests/childObserverWorker.ts", import.meta.url),
          {
            workerData: mode,
          },
        );
        onTestFinished(async () => {
          await worker.terminate();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Child observer worker exited with ${code}`));
        });
      }),
  );
});

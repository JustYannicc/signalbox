import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it.each(["turn", "interrupt", "dispose", "hydrate"])(
  "owns the controlled Claude %s through the public product Computer",
  async (scenario) => {
    const worker = new NodeWorkerThreads.Worker(
      new URL("./productHost/worker.ts", import.meta.url),
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

import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

function runIsolated(caseName: "cold" | "resume") {
  return new Promise<void>((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(
      new URL("./node/tests/claudeNativeBindingWorker.ts", import.meta.url),
      { workerData: caseName },
    );
    onTestFinished(async () => {
      await worker.terminate();
    });
    let result: unknown;
    worker.on("message", (message: unknown) => {
      result = message;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`Binding worker exited with ${code}.`));
      try {
        expect(result).toEqual({ ok: true });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

it("composes the public Claude binding with its Node process and canonical MCP route", () =>
  runIsolated("cold"));
it("hands a cold resume load back exactly once", () => runIsolated("resume"));

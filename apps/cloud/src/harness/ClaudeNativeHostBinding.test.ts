import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

function runIsolated(caseName: "cold" | "resume" | "prepared" | "both" | "omitted") {
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

it("preserves caller prepared authority without inventing resolve support", () =>
  runIsolated("prepared"));
it("preserves caller prepared and resolve overrides", () => runIsolated("both"));
it("publishes omitted release chunks through the product adapter diagnostic stream", () =>
  runIsolated("omitted"));

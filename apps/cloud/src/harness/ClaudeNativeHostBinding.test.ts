import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

function runIsolated(
  caseName:
    | "cold"
    | "resume"
    | "prepared"
    | "both"
    | "diagnostic"
    | "observation"
    | "compatibility"
    | "result"
    | "result-failure"
    | "end-failure",
) {
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

it("forwards pre-cleanup diagnostics through the public native Claude binding", () =>
  runIsolated("diagnostic"));

it("registers passive tool observation through the public Claude binding", () =>
  runIsolated("observation"));

it("rejects SDK readiness when the CLI catches an unsupported schema during startup", () =>
  runIsolated("compatibility"));

it("completes a supported SDK result through the public native binding", () =>
  runIsolated("result"));
it("rejects SDK success after a caught runtime failure", () => runIsolated("result-failure"));
it("rejects SDK stream completion after a caught runtime failure", () =>
  runIsolated("end-failure"));

it("keeps denied tool gates and unfinished MCP handshakes distinct through the public binding", () =>
  new Promise<void>((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(
      new URL("./node/tests/claudeTurnProgressWorker.ts", import.meta.url),
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
      try {
        expect(code).toBe(0);
        expect(result).toEqual({ ok: true });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }));

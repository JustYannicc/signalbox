// @effect-diagnostics nodeBuiltinImport:off - The native personality needs an isolated Node realm.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

const scenario = async (
  mode: "continue" | "revoke" | "startup-failure" | "batch" | "boundary-batch" | "unjoined-batch",
) => {
  const worker = new NodeWorkerThreads.Worker(
    new URL("./productHost/threadWorker.ts", import.meta.url),
    { workerData: mode },
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
};

it("delivers committed background continuations through the canonical Runner into the same Claude host", () =>
  scenario("continue"));

it("rejects a post-terminal continuation when the facet's current owner changes", () =>
  scenario("revoke"));

it("preserves the first startup failure and rejects subsequent work without retrying", () =>
  scenario("startup-failure"));

it("associates three owned completion blocks with the existing turn after an early Runner handoff", () =>
  scenario("batch"));

it("hands a complete three-block batch through one continuation request and one Runner turn", () =>
  scenario("boundary-batch"));

it("retains late SDK observations without inventing recorded source identities when no join is supplied", () =>
  scenario("unjoined-batch"));

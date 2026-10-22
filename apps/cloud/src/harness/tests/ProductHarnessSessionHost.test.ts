// @effect-diagnostics nodeBuiltinImport:off - A separate Node process exposes GC without changing the Vitest realm.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it.each(["turn", "interrupt", "dispose", "hydrate", "shutdown-omission"])(
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

it("collects release inputs through direct and public product composition after each seed stage", async () => {
  const output = await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      NodeProcess.execPath,
      [
        "--expose-gc",
        "--experimental-wasm-jspi",
        "--experimental-vm-modules",
        NodeURL.fileURLToPath(new URL("./productHost/retentionWorker.ts", import.meta.url)),
      ],
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr, { cause: error }));
        else resolve(stdout);
      },
    );
    NodeProcess.stderr.write(`Retention fixture PID: ${child.pid}\n`);
    onTestFinished(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.kill();
      });
    });
  });
  const result = JSON.parse(output) as {
    results: { kind: string; stage: string; collected: Record<string, boolean> }[];
  };
  expect(result.results).toEqual(
    ["direct", "product"].flatMap((kind) =>
      ["assets", "programs"].map((stage) => ({
        kind,
        stage,
        collected: {
          options: true,
          source: true,
          moduleBuffer: true,
          programs: true,
          programReader: false,
        },
      })),
    ),
  );
});

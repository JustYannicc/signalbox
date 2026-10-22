import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import type { NodeBridge } from "../../../isolate/NodeBridge.ts";
import { RELEASE_CHUNK_OMITTED_SYMBOL } from "../../ClaudeHostConfig.ts";
import type { ReleaseChunkOmittedEvent } from "../../HarnessProcessLifetime.ts";
import { fixture } from "./fixture.ts";

const f = fixture();
const reported: ReleaseChunkOmittedEvent[] = [];
const priorReporter = Object.getOwnPropertyDescriptor(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL);
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    reportReleaseChunkOmitted: (event) => reported.push(event),
    loadPackages: async () => ({}),
    loadRelease: async (bridge: NodeBridge) => ({
      launch() {
        const reporter = Reflect.get(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL);
        NodeAssert.equal(typeof reporter, "function");
        const event: ReleaseChunkOmittedEvent = {
          code: "RELEASE_CHUNK_OMITTED",
          chunkId: "bun-graph:/chunks/lazy.js",
          inputPath: "bun-graph:/chunks/lazy.js",
          tier: "corpus",
        };
        Reflect.apply(reporter, undefined, [event]);
        (bridge.require("process") as { exit: (code?: number) => never }).exit(0);
      },
    }),
  });
  try {
    NodeAssert.deepEqual(await harness.exited, { exitCode: 0, signal: 0, coreDumped: false });
  } finally {
    await harness.dispose();
  }
  NodeAssert.deepEqual(reported, [
    {
      code: "RELEASE_CHUNK_OMITTED",
      chunkId: "bun-graph:/chunks/lazy.js",
      inputPath: "bun-graph:/chunks/lazy.js",
      tier: "corpus",
    },
  ]);
  NodeAssert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL),
    priorReporter,
  );
  NodeWorkerThreads.parentPort?.postMessage({ ok: true });
} finally {
  await f.close();
}

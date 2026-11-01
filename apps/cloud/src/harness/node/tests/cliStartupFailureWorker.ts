import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY } from "../../HarnessProcessLifetime.ts";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { fixture } from "./fixture.ts";

const mode: unknown = NodeWorkerThreads.workerData;
NodeAssert.ok(mode === "rejection" || mode === "exit" || mode === "late");
const hostProcess = globalThis.process;
const f = fixture();
const original = Object.assign(new Error("detached Claude initialization failed"), {
  name: "ClaudeInitializationError",
});
const launched = Promise.withResolvers<void>();
const reported = Promise.withResolvers<void>();
const gate = Promise.withResolvers<void>();
let reportCount = 0;
let observed: unknown;
let caught: Promise<unknown> | undefined;
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    reportCliStartupFailure(cause) {
      reportCount++;
      observed = cause;
      reported.resolve();
    },
    loadRelease: async (bridge) => ({
      launch() {
        const guest = bridge.require("process");
        NodeAssert.ok(typeof guest === "object" && guest !== null);
        const report: unknown = Reflect.get(
          guest,
          Symbol.for(CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY),
        );
        NodeAssert.ok(typeof report === "function");
        const startup = async () => {
          if (mode === "late") await gate.promise;
          if (mode === "exit") {
            const exit: unknown = Reflect.get(guest, "exit");
            NodeAssert.ok(typeof exit === "function");
            Reflect.apply(exit, guest, [0]);
          }
          throw original;
        };
        caught = startup().catch((cause: unknown) => Reflect.apply(report, undefined, [cause]));
        launched.resolve();
      },
    }),
  });
  await launched.promise;
  if (mode === "late") {
    await harness.abort(new DOMException("Test owner closed", "AbortError"));
    NodeAssert.equal(globalThis.process, hostProcess);
    gate.resolve();
    await caught;
    NodeAssert.equal(reportCount, 0);
    await harness.dispose();
  } else if (mode === "exit") {
    const status = await harness.exited;
    await caught;
    NodeAssert.equal(status.exitCode, 0);
    NodeAssert.equal(status.signal, 0);
    NodeAssert.equal(reportCount, 0);
    await harness.dispose();
  } else {
    await reported.promise;
    NodeAssert.equal(reportCount, 1);
    NodeAssert.equal(observed, original);
    await NodeAssert.rejects(harness.exited, (cause: unknown) => cause === original);
    await NodeAssert.rejects(harness.dispose(), (cause: unknown) => cause === original);
  }
  NodeAssert.equal(globalThis.process, hostProcess);
} finally {
  await f.close();
}

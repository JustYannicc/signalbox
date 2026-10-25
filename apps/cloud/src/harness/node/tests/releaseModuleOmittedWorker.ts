import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { RELEASE_MODULE_OMITTED_SYMBOL } from "../../HarnessProcessLifetime.ts";
import type { NodeBridge } from "../../../isolate/NodeBridge.ts";
import { fixture } from "./fixture.ts";

type Mode = "before-exit" | "exit-listener" | "after-restore" | "after-exited";
const mode: Mode = NodeWorkerThreads.workerData;
const f = fixture();
const reported: unknown[] = [];
const failures: unknown[] = [];
const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
let sinkOpen = true;
let exited = false;
let lateReportInvokedAfterRestore = false;
let lateDiagnosticAfterRestore = false;
let lateReportError: unknown;
let startLateReport!: () => void;
let releaseLateReport!: () => void;
const lateReportStarted = new Promise<void>((resolve) => {
  startLateReport = resolve;
});
const lateReportGate = new Promise<void>((resolve) => {
  releaseLateReport = resolve;
});
const event = {
  code: "RELEASE_MODULE_OMITTED",
  inputPath: "bun-graph:/chunks/lazy.js",
  tier: "corpus",
} as const;
const report = (value: unknown) => {
  const reporter = Reflect.get(globalThis, RELEASE_MODULE_OMITTED_SYMBOL);
  if (typeof reporter !== "function") throw new Error("Release omission reporter is unavailable");
  Reflect.apply(reporter, undefined, [value]);
};
const originalDefineProperty = Object.defineProperty.bind(Object);
if (mode === "after-restore") {
  Object.defineProperty = ((target, key, descriptor) => {
    const result = originalDefineProperty(target, key, descriptor);
    if (target === globalThis && key === "fetch" && descriptor.value === priorFetch?.value) {
      queueMicrotask(() => {
        lateReportInvokedAfterRestore =
          Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value === priorFetch?.value;
        try {
          report(event);
          lateDiagnosticAfterRestore = lateReportInvokedAfterRestore;
        } catch (error) {
          lateReportError = error;
          startLateReport();
        }
      });
    }
    return result;
  }) as typeof Object.defineProperty;
}
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    reportReleaseModuleOmitted: (reportedEvent: unknown, failure?: unknown) => {
      if (!sinkOpen) throw new Error("diagnostic sink closed before late report");
      reported.push(reportedEvent);
      if (failure !== undefined) failures.push(failure);
      if (mode === "after-restore") {
        startLateReport();
        return lateReportGate;
      }
    },
    loadPackages: async () => ({}),
    loadRelease: async (bridge: NodeBridge) => ({
      launch() {
        const guestProcess = bridge.require("process") as {
          once: (name: string, listener: () => void) => unknown;
          exit: (code?: number) => never;
        };
        if (mode === "before-exit") report(event);
        if (mode === "exit-listener")
          guestProcess.once("exit", () => {
            try {
              report(event);
            } catch {}
          });
        guestProcess.exit(0);
      },
    }),
  });
  const readStdout = async () => {
    const reader = harness.stdout.getReader();
    try {
      while (!(await reader.read()).done) {}
    } finally {
      reader.releaseLock();
    }
  };
  const drainedStdout = readStdout();
  const completion = harness.exited.then((status) => {
    exited = true;
    if (mode !== "after-exited") sinkOpen = false;
    return status;
  });
  if (mode === "after-restore") {
    await lateReportStarted;
    NodeAssert.equal(exited, false, "process teardown must await the late diagnostic sink");
    NodeAssert.equal(
      sinkOpen,
      true,
      "the diagnostic sink remains open while the report is pending",
    );
    releaseLateReport();
  }
  const status = await completion;
  await drainedStdout;
  if (mode === "after-restore") {
    NodeAssert.equal(lateReportInvokedAfterRestore, true);
    NodeAssert.equal(lateReportError, undefined, "the reporter must survive personality restore");
    NodeAssert.equal(lateDiagnosticAfterRestore, true);
  }
  if (mode === "after-exited") report(event);
  NodeAssert.equal(status.exitCode, mode === "after-exited" ? 0 : 1);
  NodeAssert.equal(reported.length, 1);
  NodeAssert.deepEqual(reported[0], {
    code: "RELEASE_MODULE_OMITTED",
    inputPath: "bun-graph:/chunks/lazy.js",
    tier: "corpus",
  });
  const failure = failures[0];
  if (failure === null || (typeof failure !== "object" && typeof failure !== "function")) {
    throw new Error("Release omission failure was not an object");
  }
  NodeAssert.equal(Reflect.get(failure, "_tag"), "ReleaseModuleOmittedFailure");
  NodeAssert.equal(Reflect.get(failure, "code"), "RELEASE_MODULE_OMITTED");
  NodeAssert.equal(Reflect.get(failure, "inputPath"), event.inputPath);
  NodeAssert.equal(Reflect.get(failure, "tier"), event.tier);
  NodeAssert.match(String(Reflect.get(failure, "stack")), /releaseModuleOmittedWorker/u);
  await NodeAssert.rejects(harness.dispose(), (error) => error === failure);
  NodeAssert.equal(typeof Reflect.get(globalThis, RELEASE_MODULE_OMITTED_SYMBOL), "function");
  NodeWorkerThreads.parentPort?.postMessage({ ok: true });
} finally {
  Object.defineProperty = originalDefineProperty as typeof Object.defineProperty;
  await f.close();
}

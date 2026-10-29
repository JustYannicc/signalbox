import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import type { GuestChildren, GuestFs, GuestProcess } from "./fixture.ts";
import { fixture } from "./fixture.ts";

const f = fixture();
const mode: unknown = NodeWorkerThreads.workerData;
const failure = Object.assign(new Error("original computer failure", { cause: null }), {
  code: "EIO",
  errno: null,
  syscall: "spawn",
});
const observerFailure = new Error("observer failed");
const events: string[] = [];
let observedError: unknown;
let guestError: unknown;
let observedArgs: unknown[] | undefined;
let observedHandle: unknown;
let observedPid: number | undefined;
let ordinaryListeners: number | undefined;
let observedFd: number | undefined;
let emitted = false;
let observationDrained = false;
const observationDrainEntered = Promise.withResolvers<void>();
const allowObservationDrain = Promise.withResolvers<void>();
if (mode === "error")
  f.exec.mock.mockImplementation(async () => {
    throw failure;
  });
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    async drainChildProcessObservation() {
      NodeAssert.equal(emitted, true);
      NodeAssert.ok(events.includes("close"));
      observationDrainEntered.resolve();
      await allowObservationDrain.promise;
      const fd = f.files.open("/work/output", 0);
      f.files.close(fd);
      observationDrained = true;
    },
    onChildProcess(child, spawn) {
      NodeAssert.equal(child.pid, undefined);
      NodeAssert.equal(child.processHandle, undefined);
      NodeAssert.deepEqual(spawn.argv, ["capture", "literal"]);
      NodeAssert.equal(spawn.cwd, "/work/sub");
      NodeAssert.equal(spawn.env.EXACT, "value");
      observedFd = typeof spawn.stdio[1] === "number" ? spawn.stdio[1] : undefined;
      NodeAssert.ok(observedFd !== undefined);
      NodeAssert.equal(f.files.fstat(observedFd).type, "file");
      ordinaryListeners = child.listenerCount("error");
      child.on(NodeEvents.errorMonitor, (error: unknown) => {
        events.push("error");
        observedError = error;
        NodeAssert.equal(child.listenerCount("error"), ordinaryListeners! + 1);
      });
      NodeAssert.equal(child.listenerCount("error"), ordinaryListeners);
      child.once("spawn", () => {
        events.push("spawn");
        observedHandle = child.processHandle;
        observedPid = child.pid;
        NodeAssert.ok(observedHandle !== undefined);
        NodeAssert.ok(observedPid !== undefined);
      });
      child.once("close", (...args: unknown[]) => {
        events.push("close");
        observedArgs = args;
      });
      if (mode === "observer-throws") throw observerFailure;
    },
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      async launch() {
        const guest = bridge.require("process") as GuestProcess;
        const fs = bridge.require("fs") as GuestFs;
        const children = bridge.require("child_process") as GuestChildren;
        const fd = fs.openSync("/work/output", "w+");
        const child = children.spawn("/bin/capture", ["literal"], {
          argv0: "capture",
          cwd: "/work/sub",
          env: { EXACT: "value" },
          stdio: ["ignore", fd, "ignore"],
        });
        child.on("error", (error: unknown) => {
          guestError = error;
        });
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        fs.closeSync(fd);
        emitted = true;
        guest.exit(0);
      },
    }),
  });
  await observationDrainEntered.promise;
  let exited = false;
  void harness.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  await Promise.resolve();
  NodeAssert.equal(exited, false);
  allowObservationDrain.resolve();
  if (mode === "observer-throws") {
    await NodeAssert.rejects(
      harness.exited,
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Child process observer failed" &&
        error.cause === observerFailure,
    );
    await NodeAssert.rejects(harness.dispose());
  } else {
    NodeAssert.deepEqual(await harness.exited, { exitCode: 0, signal: 0, coreDumped: false });
    await harness.dispose();
  }
  NodeAssert.equal(emitted, true);
  NodeAssert.equal(observationDrained, true);
  NodeAssert.equal(ordinaryListeners, 1);
  NodeAssert.ok(observedHandle !== undefined);
  NodeAssert.ok(observedPid !== undefined);
  NodeAssert.equal(f.exec.mock.calls.length, 1);
  if (mode === "error") {
    NodeAssert.equal(observedError, failure);
    NodeAssert.equal(guestError, failure);
    NodeAssert.deepEqual(observedArgs, [null, null]);
    NodeAssert.deepEqual(events, ["spawn", "error", "close"]);
  } else {
    NodeAssert.equal(observedError, undefined);
    NodeAssert.deepEqual(observedArgs, [0, null]);
    NodeAssert.deepEqual(events, ["spawn", "close"]);
    const bytes = new Uint8Array(3);
    const fd = f.files.open("/work/output", 0);
    try {
      NodeAssert.equal(f.files.read(fd, bytes, 0n), 3);
      NodeAssert.deepEqual([...bytes], [255, 0, 128]);
    } finally {
      f.files.close(fd);
    }
  }
} finally {
  await f.close();
}

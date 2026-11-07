import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { KernelProcessTable } from "../../../kernel/KernelProcessTable.ts";
import { kernelOk, kernelError } from "../../../kernel/KernelAbi.ts";
import { fixture, deferred, type GuestChildren } from "./fixture.ts";

const f = fixture();
const mode: unknown = NodeWorkerThreads.workerData;
const remote = new KernelProcessTable({ wakes: f.wakes });
const completion = deferred<{ exitCode: number; signal: number; coreDumped: boolean }>();
const published = deferred<{ exitCode: number; signal: number; coreDumped: boolean }>();
const spawned = deferred<void>();
const status = { exitCode: 0, signal: 0, coreDumped: false };
const admitted = remote.spawn(
  undefined,
  () => ({ completion: completion.promise, signal: () => kernelOk(undefined) }),
  () => {},
);
if (admitted.status !== "ok") throw new Error("Remote child admission failed");
let signals = 0;
f.exec.mock.mockImplementation(async () => ({
  stdin: new WritableStream(),
  stdout: new ReadableStream({ start: (stream) => stream.close() }),
  stderr: new ReadableStream({ start: (stream) => stream.close() }),
  exited: published.promise,
  signal: async (signal) => {
    signals++;
    if (mode === "ESRCH") throw Object.assign(new Error("Already reaped"), { code: "ESRCH" });
    if (
      mode === "INVALID_HANDLE" ||
      mode === "EXPIRED" ||
      mode === "PERMISSION_DENIED" ||
      mode === "INVALID_ARGUMENT" ||
      mode === "IO_ERROR"
    )
      return kernelError(mode, "Signal failed");
    return remote.signalPid(undefined, admitted.value.pid, signal);
  },
  dispose: async () => published.resolve(status),
}));
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      launch() {
        const children = bridge.require("child_process") as GuestChildren;
        const child = children.spawn("/bin/hook");
        child.once("spawn", () => spawned.resolve());
      },
    }),
  });
  await spawned.promise;
  completion.resolve(status);
  NodeAssert.deepEqual(await remote.terminateAndReap(admitted.value.handle), kernelOk(undefined));
  const expectedError =
    mode === "PERMISSION_DENIED"
      ? "EPERM"
      : mode === "INVALID_ARGUMENT"
        ? "EINVAL"
        : mode === "IO_ERROR"
          ? "EIO"
          : undefined;
  if (expectedError === undefined) {
    await harness.abort(new Error("SDK request cancelled"));
    NodeAssert.deepEqual(await harness.exited, { ...status, signal: 15 });
    NodeAssert.deepEqual(await f.host.processes.dispose(), kernelOk(undefined));
    await harness.dispose();
  } else {
    await NodeAssert.rejects(harness.abort(new Error("SDK request cancelled")), {
      code: expectedError,
    });
    await NodeAssert.rejects(harness.exited, { code: expectedError });
    await NodeAssert.rejects(harness.dispose(), { code: expectedError });
    NodeAssert.equal((await f.host.processes.dispose()).status, "error");
  }
  NodeAssert.equal(signals, 1);
} finally {
  completion.resolve(status);
  published.resolve(status);
  await remote.dispose();
  await f.close();
}

import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { fixture } from "./fixture.ts";

const f = fixture();
try {
  const process = launchNodeHarnessProcess({
    ...f.input,
    nativeModules: NodeWorkerThreads.workerData
      ? {
          tty: {
            isatty() {
              throw new Error("Host descriptors must not be inspected");
            },
          },
        }
      : {},
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      launch() {
        const tty = bridge.require("tty");
        NodeAssert.equal(bridge.require("node:tty"), tty);
        const isatty = Reflect.get(tty, "isatty");
        for (const fd of [-1, 0, 1, 2, 42, NaN]) NodeAssert.equal(isatty(fd), false);
        for (const name of ["ReadStream", "WriteStream"]) {
          NodeAssert.throws(() => Reflect.construct(Reflect.get(tty, name), [0]), {
            code: "ENOTSUP",
            syscall: `tty.${name}`,
          });
        }
        Reflect.get(bridge.require("process"), "exit")(0);
      },
    }),
  });
  try {
    NodeAssert.deepEqual(await process.exited, { exitCode: 0, signal: 0, coreDumped: false });
  } finally {
    await process.dispose();
  }
} finally {
  await f.close();
}

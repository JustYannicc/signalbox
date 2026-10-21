import * as NodeAssert from "node:assert/strict";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { fixture } from "./fixture.ts";

const hostProcess = globalThis.process;
const f = fixture();
const seen: boolean[] = [];
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      launch() {
        const guest = bridge.require("process") as typeof hostProcess;
        const original = guest.removeListener;
        guest.removeListener = (...args: Parameters<typeof original>) => {
          seen.push(globalThis.process === guest);
          return original(...args);
        };
        guest.exit(0);
      },
    }),
  });
  try {
    NodeAssert.deepEqual(await harness.exited, { exitCode: 0, signal: 0, coreDumped: false });
  } finally {
    await harness.dispose();
  }
  NodeAssert.equal(globalThis.process, hostProcess);
  // EventEmitter's once() detaches through the guest's method while it emits; that's Node's behaviour.
  NodeAssert.deepEqual(seen, [true]);
} finally {
  await f.close();
}

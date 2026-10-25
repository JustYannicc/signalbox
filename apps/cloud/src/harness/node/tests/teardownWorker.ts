import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { fixture } from "./fixture.ts";

const aborted = NodeWorkerThreads.workerData === "abort";
const hostProcess = globalThis.process;
const f = fixture();
const seen: Array<[string, boolean]> = [];
const launched = Promise.withResolvers<void>();
try {
  const harness = launchNodeHarnessProcess({
    ...f.input,
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      launch() {
        const guest = bridge.require("process") as NodeJS.Process;
        const record = (name: string) => seen.push([name, globalThis.process === guest]);
        const wrap = (target: object, name: string, label = name) => {
          const original = Reflect.get(target, name) as (...args: unknown[]) => unknown;
          Reflect.set(target, name, (...args: unknown[]) => {
            record(label);
            return Reflect.apply(original, target, args);
          });
        };
        wrap(guest, "removeListener");
        const emit = Reflect.get(guest, "emit") as (...args: unknown[]) => unknown;
        Reflect.set(guest, "emit", (...args: unknown[]) => {
          record(`emit:${String(args[0])}`);
          return Reflect.apply(emit, guest, args);
        });
        // Detaching the host's listener defers a warning; it must still reach the guest's emit.
        guest.on("removeListener", () => guest.emitWarning("detached"));
        guest.on("warning", () => {});
        for (const stream of [guest.stdin, guest.stdout, guest.stderr]) wrap(stream, "destroy");
        launched.resolve();
        if (!aborted) guest.exit(0);
      },
    }),
  });
  try {
    if (aborted) {
      await launched.promise;
      await harness.abort();
    }
    NodeAssert.deepEqual(await harness.exited, {
      exitCode: 0,
      signal: aborted ? 15 : 0,
      coreDumped: false,
    });
  } finally {
    await harness.dispose();
  }
  NodeAssert.equal(globalThis.process, hostProcess);
  NodeAssert.ok(
    seen.some(([name]) => name === "emit:warning"),
    JSON.stringify(seen),
  );
  NodeAssert.deepEqual(
    seen.filter(([, installed]) => !installed),
    [],
  );
} finally {
  await f.close();
}

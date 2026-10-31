import { launchNodeHarnessProcess, type NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import type { NodeBridge } from "../isolate/NodeBridge.ts";

/** Imports a prepared release through normal bootstrap without invoking its launch export. */
export async function inspectNodeHarnessRelease<A>(
  input: NodeHarnessProcessInput,
  inspect: (release: object, bridge: NodeBridge, signal: AbortSignal) => Promise<A>,
) {
  let inspected: { readonly value: A } | undefined;
  const process = launchNodeHarnessProcess({
    ...input,
    loadRelease: async (bridge, signal) => {
      const release = await input.loadRelease(bridge, signal);
      if (release === null || typeof release !== "object")
        throw new TypeError("Prepared release inspection requires module exports");
      if (typeof Reflect.get(release, "launch") !== "function")
        throw new TypeError("Prepared release inspection requires a launch export");
      inspected = { value: await inspect(release, bridge, signal) };
      const assertCompatibility: unknown = Reflect.get(release, "assertRuntimeCompatibility");
      return {
        ...(typeof assertCompatibility === "function"
          ? { assertRuntimeCompatibility: () => Reflect.apply(assertCompatibility, release, []) }
          : {}),
        launch() {
          const guest = bridge.require("process");
          const exit: unknown = Reflect.get(guest, "exit");
          if (typeof exit !== "function") throw new TypeError("Node process has no exit function");
          Reflect.apply(exit, guest, [0]);
        },
      };
    },
  });
  const output = [process.stdout, process.stderr].map((stream) =>
    stream.pipeTo(new WritableStream<Uint8Array>()),
  );
  const failures: unknown[] = [];
  try {
    const status = await process.exited;
    if (status.exitCode !== 0 || status.signal !== 0)
      throw new Error("Prepared release inspection did not exit cleanly");
    if (inspected === undefined) throw new Error("Prepared release inspection did not complete");
  } catch (error) {
    failures.push(error);
  }
  const closing = await Promise.allSettled([process.dispose(), ...output]);
  for (const result of closing)
    if (result.status === "rejected" && !failures.includes(result.reason))
      failures.push(result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Prepared release inspection or cleanup failed");
  if (inspected === undefined) throw new Error("Prepared release inspection did not complete");
  return inspected.value;
}

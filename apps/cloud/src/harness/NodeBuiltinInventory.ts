import { createNodeBridge, type NodeBridge } from "../isolate/NodeBridge.ts";
import { createHarnessRuntime } from "./node/runtime.ts";
import type { NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";

/** Constructs production module objects without installing a personality or loading a release. */
export function createHarnessNodeBuiltinInventory(
  input: NodeHarnessProcessInput,
  signal: AbortSignal,
) {
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  let bridge: NodeBridge | undefined;
  try {
    const runtime = createHarnessRuntime(
      input,
      { lifetime: combined, stdin: combined, output: combined },
      () => {
        throw new Error("Builtin inventory must not launch a child process");
      },
      (): NodeBridge => (bridge ??= createNodeBridge(runtime.modules)),
    );
    let disposed: Promise<void> | undefined;
    return {
      modules: runtime.modules,
      dispose() {
        disposed ??= (async () => {
          lifetime.abort();
          const closing = Object.values(runtime.streams).map(
            (stream) =>
              new Promise<void>((resolve) => {
                if (stream.closed) return resolve();
                // Destruction can deliver a pending read's cancellation error before close.
                const onError = () => {};
                stream.on("error", onError);
                stream.once("close", () => {
                  stream.removeListener("error", onError);
                  resolve();
                });
                stream.destroy();
              }),
          );
          const results = await Promise.allSettled([...closing, runtime.drainDns()]);
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length > 0)
            throw new AggregateError(errors, "Builtin inventory cleanup failed");
        })();
        return disposed;
      },
    };
  } catch (error) {
    lifetime.abort();
    throw error;
  }
}

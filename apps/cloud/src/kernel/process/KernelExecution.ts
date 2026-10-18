// @effect-diagnostics nodeBuiltinImport:off - process-local cancellation crosses raw WASM host callbacks.
import * as NodeAsyncHooks from "node:async_hooks";

export type KernelIoMode = "async" | "sync";

interface KernelExecutionContext {
  readonly signal: AbortSignal | undefined;
  ioMode: KernelIoMode;
}

const execution = new NodeAsyncHooks.AsyncLocalStorage<KernelExecutionContext>();

export const currentKernelSignal = () => execution.getStore()?.signal;
export const currentKernelIoMode = () => execution.getStore()?.ioMode ?? "async";

export const runKernelExecution = <T>(signal: AbortSignal, run: () => T): T =>
  execution.run({ signal, ioMode: "async" }, run);

/** Marks only the synchronous part of an inline program as nonblocking I/O. */
export const runKernelInlineExecution = <T>(signal: AbortSignal | undefined, run: () => T): T => {
  const context: KernelExecutionContext = { signal, ioMode: "sync" };
  return execution.run(context, () => {
    try {
      return run();
    } finally {
      // Async work returned by an invalid inline program must not inherit sync I/O.
      context.ioMode = "async";
    }
  });
};

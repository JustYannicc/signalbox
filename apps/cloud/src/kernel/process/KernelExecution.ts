// @effect-diagnostics nodeBuiltinImport:off - process-local cancellation crosses raw WASM host callbacks.
import * as NodeAsyncHooks from "node:async_hooks";

const execution = new NodeAsyncHooks.AsyncLocalStorage<{ readonly signal: AbortSignal }>();

export const currentKernelSignal = () => execution.getStore()?.signal;

export const runKernelExecution = <T>(signal: AbortSignal, run: () => T): T =>
  execution.run({ signal }, run);

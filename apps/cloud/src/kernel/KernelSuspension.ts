// @effect-diagnostics nodeBuiltinImport:off - the worker runtime supports AsyncLocalStorage.
import * as NodeAsyncHooks from "node:async_hooks";

type KernelSuspensionListener = () => void;

const observers = new NodeAsyncHooks.AsyncLocalStorage<KernelSuspensionListener>();

export function runKernelSuspensionObserver<Value>(
  listener: KernelSuspensionListener,
  work: () => Value,
): Value {
  return observers.run(listener, work);
}

export function notifyKernelSuspension(): void {
  observers.getStore()?.();
}

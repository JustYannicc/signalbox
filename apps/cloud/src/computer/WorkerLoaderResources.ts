/** Worker Loader results are RPC stubs; release both even if one disposer fails. */
export function disposeWorkerLoaderStubs(...stubs: readonly unknown[]): void {
  const failures: unknown[] = [];
  for (const stub of stubs) {
    if ((typeof stub !== "object" && typeof stub !== "function") || stub === null) continue;
    const dispose = Reflect.get(stub, Symbol.dispose);
    if (typeof dispose !== "function") continue;
    try {
      dispose.call(stub);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Worker Loader stubs failed to dispose");
  }
}

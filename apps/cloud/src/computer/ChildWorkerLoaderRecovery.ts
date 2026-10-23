const discardedWorkerIds = new WeakMap<WorkerLoader, Set<string>>();

export const CHILD_WORKER_KILLED_BY_SIGKILL = Object.freeze({
  exitCode: 0,
  signal: 9,
  coreDumped: false,
});

/** WorkerLoader has no delete API, so failed named entries must be bypassed with load(). */
export function childWorkerStubFor(
  loader: WorkerLoader,
  workerId: string,
  code: WorkerLoaderWorkerCode,
) {
  if (discardedWorkerIds.get(loader)?.has(workerId)) return loader.load(code);
  return loader.get(workerId, () => code);
}

/** A fresh-isolate key is already unique and will not be looked up again. */
export function discardChildWorkerStub(
  loader: WorkerLoader,
  workerId: string,
  freshIsolate: boolean | undefined,
) {
  if (freshIsolate === true) return;
  let discarded = discardedWorkerIds.get(loader);
  if (discarded === undefined) {
    discarded = new Set();
    discardedWorkerIds.set(loader, discarded);
  }
  discarded.add(workerId);
}

export function isChildWorkerMemoryLimitFailure(cause: unknown): boolean {
  if (cause === "exceededMemory") return true;
  if (typeof cause === "string") return hasMemoryLimitMessage(cause);
  if (typeof cause !== "object" || cause === null) return false;
  const details = cause as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly outcome?: unknown;
  };
  return (
    details.outcome === "exceededMemory" ||
    details.code === "exceededMemory" ||
    (typeof details.message === "string" && hasMemoryLimitMessage(details.message))
  );
}

function hasMemoryLimitMessage(message: string) {
  return /\b(?:worker|isolate) exceeded(?: its)? memory limit\b/i.test(message);
}

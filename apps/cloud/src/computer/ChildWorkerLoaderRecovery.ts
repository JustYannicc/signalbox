export const CHILD_WORKER_KILLED_BY_SIGKILL = Object.freeze({
  exitCode: 0,
  signal: 9,
  coreDumped: false,
});

export function requireChildWorkerLoaderId(input: { readonly loaderId: string }): string {
  if (typeof input.loaderId !== "string" || input.loaderId.length === 0) {
    throw new TypeError("Child loader ID must be a nonempty string");
  }
  return input.loaderId;
}

/** The slot owner must retire a lost loader ID before dispatch completion is acknowledged. */
export async function acknowledgeChildWorkerMemoryLoss(target: unknown) {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    throw new TypeError("Child memory loss requires a loader retirement callback");
  }
  const lifecycle = target as { lost?: unknown; stopped?: unknown };
  if (typeof lifecycle.lost !== "function") {
    throw new TypeError("Child memory loss requires a loader retirement callback");
  }
  if (typeof lifecycle.stopped !== "function") {
    throw new TypeError("Child memory loss requires a stopped acknowledgment");
  }
  const lost = lifecycle.lost as () => Promise<void>;
  const stopped = lifecycle.stopped as () => void | Promise<void>;
  await lost.call(target);
  await stopped.call(target);
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

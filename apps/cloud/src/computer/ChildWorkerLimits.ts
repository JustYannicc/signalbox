export const DEFAULT_CHILD_CPU_MS = 300_000;

export interface ChildWorkerLimits {
  readonly cpuMs?: number;
}

export interface ResolvedChildWorkerLimits {
  readonly cpuMs: number;
}

/** Resolve host-owned child limits before admitting or loading the worker. */
export function resolveChildWorkerLimits(
  limits?: ChildWorkerLimits,
): Readonly<ResolvedChildWorkerLimits> {
  if (
    limits !== undefined &&
    (typeof limits !== "object" || limits === null || Array.isArray(limits))
  ) {
    throw new TypeError("Child worker limits must be an object");
  }

  const configuredCpuMs = limits?.cpuMs;
  const cpuMs = configuredCpuMs === undefined ? DEFAULT_CHILD_CPU_MS : configuredCpuMs;
  if (!Number.isSafeInteger(cpuMs) || cpuMs < 1) {
    throw new RangeError("Child worker cpuMs must be a positive safe integer");
  }

  return Object.freeze({ cpuMs });
}

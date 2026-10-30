export const WORKER_RUNTIME_FAILURE_TYPE = "signalbox:worker-runtime-failure:v1";

export interface WorkerRuntimeFailureMessage {
  readonly type: typeof WORKER_RUNTIME_FAILURE_TYPE;
  readonly failure: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringProperty(value: unknown, key: string, fallback: string): string {
  try {
    const property = value === null ? undefined : Reflect.get(value as object, key);
    return typeof property === "string" ? property : fallback;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "Worker runtime failure";
  }
}

export function createWorkerRuntimeFailureMessage(error: unknown): WorkerRuntimeFailureMessage {
  const code = stringProperty(error, "code", "");
  return {
    type: WORKER_RUNTIME_FAILURE_TYPE,
    failure: {
      name: stringProperty(error, "name", "Error"),
      message: stringProperty(error, "message", stringify(error)),
      ...(code.length === 0 ? {} : { code }),
    },
  };
}

/** Returns a host-owned Error for a reserved report message, including malformed reports. */
export function readWorkerRuntimeFailure(value: unknown): Error | undefined {
  const message = record(value);
  if (message?.type !== WORKER_RUNTIME_FAILURE_TYPE) return undefined;
  const failure = record(message.failure);
  if (
    failure === undefined ||
    typeof failure.name !== "string" ||
    typeof failure.message !== "string" ||
    (failure.code !== undefined && typeof failure.code !== "string")
  ) {
    const error = new Error("Worker runtime failure report is malformed");
    error.name = "WorkerRuntimeFailureReportError";
    Object.assign(error, { code: "WORKER_RUNTIME_FAILURE_INVALID" });
    return error;
  }

  const error = new Error(failure.message);
  error.name = failure.name;
  if (typeof failure.code === "string") Object.assign(error, { code: failure.code });
  return error;
}

export function createHostRuntimeFailure(value: unknown): Error {
  return readWorkerRuntimeFailure(createWorkerRuntimeFailureMessage(value))!;
}

export function createRuntimeFailureState() {
  const failure = Promise.withResolvers<never>();
  let error: Error | undefined;
  void failure.promise.catch(() => undefined);
  return {
    failure: failure.promise,
    get error() {
      return error;
    },
    report(value: unknown) {
      if (error !== undefined) return false;
      error = createHostRuntimeFailure(value);
      failure.reject(error);
      return true;
    },
    assert() {
      if (error !== undefined) throw error;
    },
  };
}

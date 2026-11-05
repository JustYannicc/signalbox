import { ChildWorkerDispatchError } from "./KernelWorkerDispatchError.ts";

export interface KernelWorkerFailure {
  readonly message: string;
  readonly code?: string;
  readonly confirmed: boolean;
}

export function describeKernelWorkerFailure(error: unknown): KernelWorkerFailure {
  const cause = error instanceof ChildWorkerDispatchError ? error.cause : error;
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    ...(typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
      ? { code: cause.code }
      : {}),
    confirmed: error instanceof ChildWorkerDispatchError && error.termination.kind === "stopped",
  };
}

export function restoreKernelWorkerFailure(failure: KernelWorkerFailure, stopped: Promise<void>) {
  const cause = Object.assign(
    new Error(failure.message),
    failure.code === undefined ? {} : { code: failure.code },
  );
  return new ChildWorkerDispatchError(
    cause,
    failure.confirmed ? { kind: "stopped" } : { kind: "unconfirmed", stopped },
  );
}

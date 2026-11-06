import { WasiError } from "../wasi/internal_wasi_memory.ts";
import { complete, runSync } from "../wasi/internal_wasi_calls.ts";

import { kernelError, WASI_ERRNO_CODES } from "../KernelErrno.ts";
export { kernelError } from "../KernelErrno.ts";

/** Runs one sync or async-storage result through the synchronous kernel view. */
export function runKernelSync<T>(value: T | Promise<T>): T {
  return withKernelErrors(() => runSync(complete(value)));
}

export function withKernelErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw normalizeKernelError(error);
  }
}

export async function withKernelErrorsAsync<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeKernelError(error);
  }
}

function normalizeKernelError(error: unknown): unknown {
  if (error instanceof WasiError) {
    return kernelError(WASI_ERRNO_CODES[error.errno] ?? "EIO", error.message);
  }
  if (error instanceof TypeError && error.message === "WASI call requires asynchronous execution") {
    return kernelError("ENOTSUP", error.message);
  }
  return error;
}

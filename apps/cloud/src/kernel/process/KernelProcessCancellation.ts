/** A child stopped because its owning execution was cancelled. */
export class KernelProcessCancelledError extends Error {
  constructor(message = "Process execution was cancelled") {
    super(message);
    this.name = "KernelProcessCancelledError";
  }
}

export function isKernelProcessCancelledError(
  error: unknown,
): error is KernelProcessCancelledError {
  return error instanceof KernelProcessCancelledError;
}

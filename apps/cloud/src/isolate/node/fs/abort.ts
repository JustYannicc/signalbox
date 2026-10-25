export class NodeFsAbortError extends Error {
  readonly code = "ABORT_ERR";

  constructor(reason: unknown) {
    super("The operation was aborted", { cause: reason });
    this.name = "AbortError";
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NodeFsAbortError(signal.reason);
}

/** Only this operation's forwarded signal carries a Node abort, so I/O failures stay distinct. */
export async function withNodeAbort<T>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new NodeFsAbortError(signal.reason));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await operation(controller.signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

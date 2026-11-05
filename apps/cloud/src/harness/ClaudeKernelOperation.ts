// @effect-diagnostics cryptoRandomUUID:off - Operation IDs connect explicit cross-owner cancellation.
import type { ClaudeKernelSessionPort } from "./ClaudeKernelSessionPort.ts";

/** RPC does not carry AbortSignal state. Keep the cancel path live until the owner replies. */
export async function claudeKernelOperation<A>(
  kernel: Pick<ClaudeKernelSessionPort, "cancel">,
  signal: AbortSignal,
  run: (id: string) => Promise<A>,
): Promise<A> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const abort = () => {
    void kernel.cancel(id, signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await run(id);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

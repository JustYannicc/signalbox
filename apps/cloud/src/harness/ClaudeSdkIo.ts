import type { ClaudeCliProcessPort } from "./ClaudeSdkHostProtocol.ts";
import { retainRpcResponse } from "../rpc/Resources.ts";

let sequence = 0;

/** AbortSignal RPC is experimental. Keep it local and forward cancellation explicitly. */
export async function claudeSdkIo<A>(
  port: Pick<ClaudeCliProcessPort, "cancelIo">,
  signal: AbortSignal | undefined,
  run: (id: string) => Promise<A>,
) {
  signal?.throwIfAborted();
  const id = String(++sequence);
  const abort = () => {
    void port.cancelIo(id, signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await run(id);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export function claudeSdkModelTransport(port: Pick<ClaudeCliProcessPort, "model" | "cancelIo">) {
  return async (request: Request) => {
    request.signal.throwIfAborted();
    const id = String(++sequence);
    const abort = () => {
      void port.cancelIo(id, request.signal.reason).catch(() => undefined);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const release = () => request.signal.removeEventListener("abort", abort);
    try {
      const response = await port.model(id, {
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        redirect: request.redirect,
        body: request.body,
      });
      return await retainRpcResponse(response, {
        signal: request.signal,
        result: { [Symbol.dispose]: release },
      });
    } catch (cause) {
      release();
      throw cause;
    }
  };
}

export interface ClaudeSdkRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly redirect: RequestRedirect;
  readonly body: ReadableStream<Uint8Array> | null;
}

import { NodeGeneratedCodeCleanupError } from "./invocation-errors.ts";
import type { NodeGeneratedCodeInvocation, NodeGeneratedCodeOpenPort } from "./invocation.ts";

/** Keep this adapter beside the caller's signal, outside native HTTP cancellation. */
export function createNodeGeneratedCodeFetcher(port: NodeGeneratedCodeOpenPort) {
  return {
    async fetch(request: Request): Promise<Response> {
      request.signal.throwIfAborted();
      const envelope = await request.text();
      request.signal.throwIfAborted();
      const invocation = await port.open(envelope);
      return invocationResponse(invocation, request.signal);
    },
  };
}

function invocationResponse(invocation: NodeGeneratedCodeInvocation, signal: AbortSignal) {
  const result = Promise.withResolvers<Response>();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    invocation[Symbol.dispose]();
  };
  const fail = (error: unknown) => {
    result.reject(error);
    controller?.error(error);
  };
  const cancel = () => {
    if (cancellation) return cancellation;
    if (finished) return Promise.resolve();
    cancellation = (async () => {
      try {
        await invocation.cancel();
      } catch (cause) {
        signal.removeEventListener("abort", abort);
        // Disposal only drops a reference. It cannot turn a failed cleanup into an acknowledgment.
        throw new NodeGeneratedCodeCleanupError(cause);
      }
      finish();
    })();
    return cancellation;
  };
  const abort = () => {
    void cancel().then(() => fail(signal.reason), fail);
  };
  const failAfterCleanup = async (error: unknown) => {
    try {
      await cancel();
      fail(signal.aborted ? signal.reason : error);
    } catch (cleanupError) {
      fail(cleanupError);
    }
  };

  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
    return result.promise;
  }

  void (async () => {
    try {
      const head = await invocation.run();
      if (cancellation) await cancellation;
      signal.throwIfAborted();
      const body = head.hasBody
        ? new ReadableStream<Uint8Array>(
            {
              start(value) {
                controller = value;
              },
              async pull(value) {
                try {
                  const next = await invocation.read();
                  if (cancellation) await cancellation;
                  signal.throwIfAborted();
                  if (next.done) {
                    finish();
                    value.close();
                  } else {
                    value.enqueue(next.value);
                  }
                } catch (error) {
                  await failAfterCleanup(error);
                }
              },
              cancel,
            },
            { highWaterMark: 0 },
          )
        : null;
      const response = new Response(body, head);
      if (!head.hasBody) finish();
      result.resolve(response);
    } catch (error) {
      await failAfterCleanup(error);
    }
  })();
  return result.promise;
}

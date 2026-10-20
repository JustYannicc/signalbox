import type { NodeHarnessProcessInput } from "./types.ts";

/** Tracks transport calls and response reads until cancellation has settled. */
export function createHarnessModelTransport(
  transport: NodeHarnessProcessInput["modelTransport"],
  signal: AbortSignal,
) {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };
  const activeBodies = new Set<() => Promise<void>>();
  const stop = () => {
    for (const cancel of activeBodies) void track(cancel()).catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  const request: typeof globalThis.fetch = async (resource, init) => {
    signal.throwIfAborted();
    const request = new Request(resource, init);
    const forwarded = new Request(request, { signal: AbortSignal.any([signal, request.signal]) });
    const response = await track(Promise.resolve().then(() => transport(forwarded)));
    if (signal.aborted) {
      await response.body?.cancel(signal.reason);
      signal.throwIfAborted();
    }
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let done = false;
    let cancellation: Promise<void> | undefined;
    const complete = () => {
      done = true;
      activeBodies.delete(cancel);
    };
    const cancel = (): Promise<void> => {
      cancellation ??= reader.cancel(signal.reason).finally(complete);
      return cancellation;
    };
    activeBodies.add(cancel);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const result = await track(reader.read());
            if (result.done) {
              complete();
              controller.close();
            } else controller.enqueue(result.value);
          } catch (error) {
            complete();
            controller.error(error);
          }
        },
        cancel: () => track(cancel()),
      },
      { highWaterMark: 0 },
    );
    if (signal.aborted) await track(cancel());
    const wrapped = new Response(body, response);
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    // A complete response can still have a public unread EOF; no underlying work remains.
    if (done) activeBodies.delete(cancel);
    return wrapped;
  };
  const fetch: typeof globalThis.fetch = (resource, init) => track(request(resource, init));
  return {
    fetch,
    async drain() {
      stop();
      while (pending.size > 0) await Promise.allSettled(pending);
      signal.removeEventListener("abort", stop);
    },
  };
}

let activeCalls = 0;
let peakCalls = 0;
let calls = 0;
let acquiredResults = 0;
let disposedResults = 0;
let activeResults = 0;
let activeStubs = 0;
let activeResponseBodies = 0;
let responseBodyBytes = 0;
let failedResultDisposals = 0;
let failedStubDisposals = 0;
let disposedStubs = 0;

function disposer(value: unknown): (() => void) | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const dispose = Reflect.get(value, Symbol.dispose);
  return typeof dispose === "function" ? () => dispose.call(value) : undefined;
}

function ownResult(value: unknown) {
  const dispose = disposer(value);
  if (dispose === undefined) return () => {};
  acquiredResults++;
  activeResults++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      dispose();
      disposedResults++;
    } catch (cause) {
      failedResultDisposals++;
      throw cause;
    } finally {
      activeResults--;
    }
  };
}

/** Data RPCs never transfer live capabilities. Detach their data before releasing the result. */
export async function readRpcData<A>(pending: A): Promise<Awaited<A>> {
  calls++;
  activeCalls++;
  peakCalls = Math.max(peakCalls, activeCalls);
  try {
    const value = await pending;
    if (disposer(value) === undefined) return value;
    const release = ownResult(value);
    try {
      return structuredClone(value);
    } finally {
      release();
    }
  } finally {
    activeCalls--;
  }
}

/** Namespace lookup stubs belong to the operation that looked them up. Env bindings are borrowed. */
export async function withRpcStub<S, A>(stub: S, run: (stub: S) => Promise<A>): Promise<A> {
  using _owner = rpcStubOwner(stub);
  return await run(stub);
}

/** A streamed response owns its RPC result until EOF, cancellation, or a failed read. */
export async function readRpcResponse(pending: PromiseLike<Response>, signal?: AbortSignal) {
  calls++;
  activeCalls++;
  peakCalls = Math.max(peakCalls, activeCalls);
  let response: Response;
  try {
    response = await pending;
  } finally {
    activeCalls--;
  }
  const releaseResult = ownResult(response);
  let release = releaseResult;
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    };
    if (response.body === null) {
      const copy = new Response(null, init);
      release();
      return copy;
    }
    const reader = response.body.getReader();
    bodyReader = reader;
    activeResponseBodies++;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      activeResponseBodies--;
      signal?.removeEventListener("abort", abort);
      try {
        reader.releaseLock();
      } finally {
        releaseResult();
      }
    };
    release = finish;
    const abort = () => {
      void reader
        .cancel(signal?.reason)
        .finally(finish)
        .catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              finish();
              controller.close();
            } else {
              responseBodyBytes += item.value.byteLength;
              controller.enqueue(item.value);
            }
          } catch (cause) {
            let failure = cause;
            try {
              finish();
            } catch (cleanup) {
              failure = new AggregateError(
                [cause, cleanup],
                "RPC response read and cleanup failed",
                { cause },
              );
            }
            controller.error(failure);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      },
      { highWaterMark: 0 },
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return new Response(body, init);
  } catch (cause) {
    const failures: unknown[] = [cause];
    try {
      if (bodyReader) await bodyReader.cancel(cause);
      else await response.body?.cancel(cause);
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      release();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "RPC response construction and cleanup failed", { cause });
    throw cause;
  }
}

export function rpcResourceSnapshot() {
  return {
    calls,
    activeCalls,
    peakCalls,
    acquiredResults,
    disposedResults,
    activeResults,
    activeStubs,
    disposedStubs,
    failedResultDisposals,
    failedStubDisposals,
    activeResponseBodies,
    responseBodyBytes,
    heapBytes: null,
    rssBytes: null,
    memoryMeasurement: "unavailable" as const,
  };
}

export function rpcStubOwner(stub: unknown): Disposable {
  const dispose = disposer(stub);
  if (dispose) activeStubs++;
  let closed = false;
  return {
    [Symbol.dispose]() {
      if (closed) return;
      closed = true;
      if (dispose) {
        try {
          dispose();
          disposedStubs++;
        } catch (cause) {
          failedStubDisposals++;
          throw cause;
        } finally {
          activeStubs--;
        }
      }
    },
  };
}

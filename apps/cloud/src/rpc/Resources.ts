import { ownRpcResponse } from "./response.ts";

let activeCalls = 0;
let peakCalls = 0;
let calls = 0;
let acquiredResults = 0;
let disposedResults = 0;
let activeResults = 0;
let activeStubs = 0;
let activeResponseBodies = 0;
let activeResponseWebSockets = 0;
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

/** Detaches plain data from an already-awaited RPC result without counting another call. */
export function detachRpcData<A>(value: A): A {
  if (disposer(value) === undefined) return value;
  const release = ownResult(value);
  try {
    const copy = structuredClone(value);
    release();
    return copy;
  } catch (cause) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], "RPC data copy and cleanup failed", { cause });
    }
    throw cause;
  }
}

export function releaseRpcResult(value: unknown): void {
  ownResult(value)();
}

/** Data RPCs never transfer live capabilities. Detach their data before releasing the result. */
export async function readRpcData<A>(pending: A): Promise<Awaited<A>> {
  calls++;
  activeCalls++;
  peakCalls = Math.max(peakCalls, activeCalls);
  try {
    return detachRpcData(await pending);
  } finally {
    activeCalls--;
  }
}

/** Namespace lookup stubs belong to the operation that looked them up. Env bindings are borrowed. */
export async function withRpcStub<S, A>(stub: S, run: (stub: S) => Promise<A>): Promise<A> {
  using _owner = rpcStubOwner(stub);
  return await run(stub);
}

/** Retains a response and any enclosing RPC result through body or WebSocket completion. */
export async function retainRpcResponse(
  response: Response,
  options: { readonly result?: unknown; readonly signal?: AbortSignal | undefined } = {},
) {
  const releases = [...new Set([response, options.result])].map(ownResult);
  let released = false;
  return ownRpcResponse(response, {
    signal: options.signal,
    release() {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      for (const release of releases) {
        try {
          release();
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "RPC result cleanup failed", { cause: failures[0] });
    },
    bodyOpened() {
      activeResponseBodies++;
    },
    bodyClosed() {
      activeResponseBodies--;
    },
    bodyBytes(bytes) {
      responseBodyBytes += bytes;
    },
    socketOpened() {
      activeResponseWebSockets++;
    },
    socketClosed() {
      activeResponseWebSockets--;
    },
  });
}

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
  return retainRpcResponse(response, { signal });
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
    activeResponseWebSockets,
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

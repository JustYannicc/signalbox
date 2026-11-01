interface ResponseOwnership {
  readonly release: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly bodyOpened: () => void;
  readonly bodyClosed: () => void;
  readonly bodyBytes: (bytes: number) => void;
  readonly socketOpened: () => void;
  readonly socketClosed: () => void;
}

/** Keeps an upgrade intact. Its caller owns acceptance and the socket protocol. */
function retainUpgrade(response: Response, socket: WebSocket, owner: ResponseOwnership) {
  let closed = false;
  owner.socketOpened();
  const finish = () => {
    if (closed) return;
    closed = true;
    socket.removeEventListener("close", finish);
    socket.removeEventListener("error", finish);
    owner.signal?.removeEventListener("abort", abort);
    owner.socketClosed();
    owner.release();
  };
  const abort = () => {
    try {
      socket.close(1000, "");
    } finally {
      finish();
    }
  };
  socket.addEventListener("close", finish, { once: true });
  socket.addEventListener("error", finish, { once: true });
  owner.signal?.addEventListener("abort", abort, { once: true });
  if (owner.signal?.aborted) {
    abort();
    owner.signal.throwIfAborted();
  }
  if (socket.readyState === 3) finish();
  return response;
}

/** A response retains its remote capabilities until the body or socket settles. */
export async function ownRpcResponse(response: Response, owner: ResponseOwnership) {
  let release = owner.release;
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.webSocket != null) return retainUpgrade(response, response.webSocket, owner);
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
    owner.bodyOpened();
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      owner.bodyClosed();
      owner.signal?.removeEventListener("abort", abort);
      const failures: unknown[] = [];
      try {
        reader.releaseLock();
      } catch (cause) {
        failures.push(cause);
      }
      try {
        owner.release();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "RPC response cleanup failed", { cause: failures[0] });
    };
    release = finish;
    const abort = () => {
      void reader
        .cancel(owner.signal?.reason)
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
              owner.bodyBytes(item.value.byteLength);
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
                {
                  cause,
                },
              );
            }
            controller.error(failure);
          }
        },
        async cancel(reason) {
          let failed = false;
          let failure: unknown;
          try {
            await reader.cancel(reason);
          } catch (cause) {
            failed = true;
            failure = cause;
          }
          try {
            finish();
          } catch (cleanup) {
            if (failed)
              throw new AggregateError(
                [failure, cleanup],
                "RPC response cancel and cleanup failed",
                {
                  cause: failure,
                },
              );
            throw cleanup;
          }
          if (failed) throw failure;
        },
      },
      { highWaterMark: 0 },
    );
    owner.signal?.addEventListener("abort", abort, { once: true });
    if (owner.signal?.aborted) abort();
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

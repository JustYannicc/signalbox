function disposer(value: unknown): (() => void) | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const dispose = Reflect.get(value, Symbol.dispose);
  return typeof dispose === "function" ? () => dispose.call(value) : undefined;
}

/** Copies response metadata and keeps both RPC results alive until its stream settles. */
export function relayRpcResponse(response: Response, result: unknown): Response {
  const disposeResponse = disposer(response);
  const disposeResult = disposer(result);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  let constructionCleanupPending = false;

  const release = () => {
    if (released) return;
    released = true;
    let failure: unknown;
    try {
      reader?.releaseLock();
    } catch (cause) {
      failure = cause;
    }
    try {
      disposeResponse?.();
    } catch (cause) {
      failure ??= cause;
    }
    try {
      disposeResult?.();
    } catch (cause) {
      failure ??= cause;
    }
    if (failure !== undefined) throw failure;
  };

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

    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let item: ReadableStreamReadResult<Uint8Array>;
          try {
            item = await reader!.read();
          } catch (cause) {
            try {
              release();
            } catch {
              // Keep the original stream error.
            }
            controller.error(cause);
            return;
          }

          if (item.done) {
            try {
              release();
              controller.close();
            } catch (cause) {
              controller.error(cause);
            }
          } else {
            controller.enqueue(item.value);
          }
        },
        async cancel(reason) {
          let failure: unknown;
          try {
            await reader!.cancel(reason);
          } catch (cause) {
            failure = cause;
          }
          try {
            release();
          } catch (cause) {
            failure ??= cause;
          }
          if (failure !== undefined) throw failure;
        },
      },
      { highWaterMark: 0 },
    );

    try {
      return new Response(body, init);
    } catch (cause) {
      constructionCleanupPending = true;
      void reader
        .cancel(cause)
        .catch(() => undefined)
        .finally(() => {
          try {
            release();
          } catch {
            // Preserve the response-construction error.
          }
        });
      throw cause;
    }
  } catch (cause) {
    if (!constructionCleanupPending) {
      try {
        release();
      } catch {
        // Preserve the original setup error.
      }
    }
    throw cause;
  }
}

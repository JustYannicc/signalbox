import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git/http/web";
import { collectRequestBody, toArrayBuffer, transferLimitError } from "./http-request.ts";

export interface GitHttpClient {
  readonly http: HttpClient;
  readonly dispose: () => Promise<void>;
}

interface ManagedBody {
  readonly body: AsyncGenerator<Uint8Array>;
  readonly started: () => boolean;
  readonly cancel: (reason?: unknown) => Promise<void>;
}

export function createGitHttpClient(
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  maxTransferBytes: number,
): GitHttpClient {
  const bodies = new Set<ManagedBody>();
  let transferredBytes = 0;

  const http: HttpClient = Object.freeze({
    request: async (request: GitHttpRequest): Promise<GitHttpResponse> => {
      signal.throwIfAborted();
      await cancelUnconsumedBodies(bodies, signal.reason);
      const body =
        request.body === undefined
          ? undefined
          : await collectRequestBody(
              request.body as unknown,
              signal,
              maxTransferBytes - transferredBytes,
              awaitWithAbort,
            );
      signal.throwIfAborted();
      if (body !== undefined) {
        transferredBytes += body.byteLength;
        if (transferredBytes > maxTransferBytes) throw transferLimitError(maxTransferBytes);
      }

      const pendingResponse = Promise.resolve(
        fetcher(request.url, {
          method: request.method ?? "GET",
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(body === undefined ? {} : { body: toArrayBuffer(body) }),
          signal,
        }),
      );
      let response: Response;
      try {
        response = await awaitWithAbort(pendingResponse, signal);
      } catch (error) {
        void pendingResponse.then(
          (lateResponse) => lateResponse.body?.cancel(error).catch(() => undefined),
          () => undefined,
        );
        throw error;
      }

      const declaredLength = parseContentLength(response.headers.get("content-length"));
      if (declaredLength !== undefined && declaredLength > maxTransferBytes - transferredBytes) {
        await response.body?.cancel();
        throw transferLimitError(maxTransferBytes);
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      let managedBody: ManagedBody | undefined;
      if (response.body !== null) {
        managedBody = manageResponseBody(
          response.body,
          signal,
          maxTransferBytes,
          () => transferredBytes,
          (size) => {
            transferredBytes += size;
          },
          () => {
            if (managedBody !== undefined) bodies.delete(managedBody);
          },
        );
        bodies.add(managedBody);
      }

      return {
        url: response.url || request.url,
        method: request.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers,
        body: managedBody?.body ?? emptyBody(),
      };
    },
  });

  return {
    http,
    dispose: async () => {
      await Promise.all([...bodies].map((body) => body.cancel(signal.reason)));
    },
  };
}

function manageResponseBody(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxTransferBytes: number,
  transferred: () => number,
  addTransferred: (bytes: number) => void,
  onSettled: () => void,
): ManagedBody {
  const reader = stream.getReader();
  let started = false;
  let done = false;
  let released = false;
  const cancel = async (reason?: unknown) => {
    if (released) return;
    released = true;
    try {
      if (!done) await reader.cancel(reason);
    } catch {
      // Cancellation is best effort; the original transport or parse error stays primary.
    } finally {
      reader.releaseLock();
      onSettled();
    }
  };
  const managed: ManagedBody = {
    body: (async function* () {
      started = true;
      try {
        for (;;) {
          signal.throwIfAborted();
          const result = await awaitWithAbort(reader.read(), signal);
          if (result.done) {
            done = true;
            return;
          }
          if (result.value.byteLength > maxTransferBytes - transferred()) {
            throw transferLimitError(maxTransferBytes);
          }
          addTransferred(result.value.byteLength);
          yield result.value;
        }
      } finally {
        await cancel(signal.aborted ? signal.reason : undefined);
      }
    })(),
    started: () => started,
    cancel,
  };
  return managed;
}

async function cancelUnconsumedBodies(bodies: Set<ManagedBody>, reason?: unknown): Promise<void> {
  await Promise.all(
    [...bodies].filter((body) => !body.started()).map((body) => body.cancel(reason)),
  );
}

function emptyBody(): AsyncGenerator<Uint8Array> {
  return (async function* () {})();
}

export function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

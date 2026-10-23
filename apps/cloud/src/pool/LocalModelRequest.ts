import { RpcTarget, type RpcStub } from "cloudflare:workers";

export interface LocalModelRequestApi extends RpcTarget {
  readonly response: () => Promise<Response>;
  readonly cancel: () => Promise<void>;
}

/** The controller stays beside the fetch; its caller holds an abort capability. */
export class LocalModelRequest extends RpcTarget implements LocalModelRequestApi {
  readonly #controller = new AbortController();
  readonly #fetch: () => Promise<Response>;
  #response: Promise<Response> | undefined;

  constructor(request: Request, fetch: (request: Request) => Promise<Response>) {
    super();
    this.#fetch = () => {
      this.#controller.signal.throwIfAborted();
      return fetch(new Request(request, { signal: this.#controller.signal }));
    };
  }

  response() {
    return (this.#response ??= Promise.resolve().then(this.#fetch));
  }

  async cancel() {
    this.#controller.abort(new DOMException("Model request cancelled", "AbortError"));
  }
}

/** Streams over RPC without serializing AbortSignal, retaining cancellation through EOF. */
export async function forwardLocalModelRequest(
  request: Request,
  start: (request: Request) => Promise<RpcStub<LocalModelRequestApi>>,
) {
  const signal = request.signal;
  signal.throwIfAborted();
  let remote: RpcStub<LocalModelRequestApi> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    remote?.[Symbol.dispose]();
  };
  const cancel = async () => {
    try {
      await remote?.cancel();
    } finally {
      await reader?.cancel(signal.reason);
    }
  };
  const abort = () => {
    if (remote !== undefined)
      void cancel()
        .catch(() => undefined)
        .finally(finish);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // A fresh Request has no explicit signal for workerd's RPC serializer to copy.
    const init: RequestInit & { readonly duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      duplex: "half",
    };
    remote = await start(new Request(request.url, init));
    if (signal.aborted) {
      await cancel();
      signal.throwIfAborted();
    }
    const response = await remote.response();
    if (signal.aborted) {
      await cancel();
      signal.throwIfAborted();
    }
    if (response.body === null) {
      finish();
      return response;
    }
    const bodyReader = response.body.getReader();
    reader = bodyReader;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await bodyReader.read();
          if (signal.aborted) signal.throwIfAborted();
          if (chunk.done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel() {
        try {
          await cancel();
        } finally {
          finish();
        }
      },
    });
    const wrapped = new Response(body, response);
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  } catch (error) {
    finish();
    throw error;
  }
}

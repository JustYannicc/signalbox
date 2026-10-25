// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node requests need native Writable semantics and request-owned timeout callbacks.
import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import type {
  HttpServerHandler,
  LocalRequestOptions,
  NodeStyleHttpServer,
} from "./HttpClientTypes.ts";
import { LocalIncomingMessage } from "./HttpIncomingMessage.ts";
import { addRequestMarker, attachRequestCancellation } from "./HttpRequestCancellation.ts";
import { createHeaders, validateHeaderName } from "./HttpRequestHeaders.ts";
import { connectionRefused, networkError } from "./errors.ts";

export class LocalClientRequest extends NodeStream.Writable {
  readonly method: string;
  readonly path: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  readonly agent: unknown;
  readonly socket = null;
  readonly connection = null;
  readonly reusedSocket = false;
  readonly maxHeadersCount = Infinity;
  aborted = false;
  #options: LocalRequestOptions;
  #headers = new Map<string, { name: string; values: string[] }>();
  #controller = new AbortController();
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #started = false;
  #incoming: LocalIncomingMessage | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #timeoutMs = 0;

  constructor(options: LocalRequestOptions, fallbackAgent: unknown) {
    super({ autoDestroy: false, decodeStrings: true });
    this.#options = options;
    this.method = options.parsed.method;
    this.path = options.parsed.path;
    this.protocol = `${options.parsed.protocol}:`;
    this.host = options.parsed.host;
    this.port = options.parsed.port;
    this.agent = options.parsed.options.agent ?? fallbackAgent;
    for (const [name, value] of createHeaders(
      options.parsed.options,
      this.host,
      this.port,
      options.parsed.protocol,
    )) {
      this.#headers.set(name.toLowerCase(), { name, values: [value] });
    }
    if (options.parsed.options.signal instanceof AbortSignal) {
      const signal = options.parsed.options.signal;
      const abort = () => this.destroy(networkError("ABORT_ERR", "The operation was aborted"));
      if (signal.aborted) queueMicrotask(abort);
      else signal.addEventListener("abort", abort, { once: true });
      this.once("close", () => signal.removeEventListener("abort", abort));
    }
    if (options.parsed.options.timeout !== undefined)
      this.setTimeout(Number(options.parsed.options.timeout));
    if (options.parsed.callback) this.once("response", options.parsed.callback);
  }

  get res(): LocalIncomingMessage | undefined {
    return this.#incoming;
  }

  setHeader(name: string, value: string | number | readonly (string | number)[]): this {
    if (this.#started)
      throw networkError(
        "ERR_HTTP_HEADERS_SENT",
        "Cannot set headers after they are sent to the client",
      );
    validateHeaderName(name);
    const values = (Array.isArray(value) ? value : [value]).map(String);
    this.#headers.set(name.toLowerCase(), { name, values });
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    const header = this.#headers.get(name.toLowerCase());
    if (!header) return undefined;
    return header.values.length === 1 ? header.values[0] : [...header.values];
  }

  getHeaders(): Record<string, string | string[]> {
    return Object.fromEntries(
      [...this.#headers].map(([name, header]) => [
        name,
        header.values.length === 1 ? header.values[0]! : [...header.values],
      ]),
    );
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (this.#started)
      throw networkError(
        "ERR_HTTP_HEADERS_SENT",
        "Cannot remove headers after they are sent to the client",
      );
    this.#headers.delete(name.toLowerCase());
  }

  flushHeaders(): void {
    this.#start();
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RangeError("timeout must be a non-negative finite number");
    this.#timeoutMs = Math.min(milliseconds, 2_147_483_647);
    if (callback) this.once("timeout", callback);
    this.#touch();
    return this;
  }

  clearTimeout(): this {
    this.setTimeout(0);
    return this;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.destroy(networkError("ABORT_ERR", "The operation was aborted"));
    queueMicrotask(() => this.emit("abort"));
  }

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.method === "GET" || this.method === "HEAD") {
      callback(
        networkError(
          "ERR_HTTP_BODY_NOT_ALLOWED",
          `Request method ${this.method} does not support a body`,
        ),
      );
      return;
    }
    this.#start();
    const writer = this.#writer;
    if (!writer) {
      callback(networkError("ERR_HTTP_REQUEST_NOT_STARTED", "Local request body is unavailable"));
      return;
    }
    const payload =
      typeof chunk === "string"
        ? NodeBuffer.Buffer.from(chunk, encoding)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    void writer.write(payload).then(
      () => {
        this.#touch();
        callback();
      },
      (error: unknown) => callback(error as Error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#start();
    if (!this.#writer) {
      callback();
      return;
    }
    void this.#writer.close().then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#controller.abort(error);
    if (this.#incoming && !this.#incoming.complete) {
      this.#incoming.aborted = true;
      this.#incoming.destroy(error ?? networkError("ECONNRESET", "aborted"));
    }
    const cleanup = this.#writer?.abort(error).catch(() => {});
    if (cleanup) void cleanup.then(() => callback(error));
    else callback(error);
  }

  #start(): void {
    if (this.#started || this.destroyed) return;
    this.#started = true;
    const { parsed, binding, registry, handlerFor, env, ctx } = this.#options;
    if (!binding || registry.get(binding.port) !== binding) {
      this.#failBeforeDispatch(connectionRefused(parsed.host, parsed.port));
      return;
    }
    const headers = new Headers();
    for (const header of this.#headers.values()) {
      for (const value of header.values) headers.append(header.name, value);
    }
    const method = parsed.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    let body: ReadableStream<Uint8Array> | undefined;
    if (hasBody) {
      const stream = new TransformStream<Uint8Array, Uint8Array>(
        undefined,
        { highWaterMark: 1 },
        { highWaterMark: 1 }, // Let the producer progress before the host starts consuming the body.
      );
      this.#writer = stream.writable.getWriter();
      body = stream.readable;
    }
    const requestMarker = addRequestMarker(headers);
    let request: Request;
    try {
      request = new Request(parsed.url, {
        method,
        headers,
        ...(body ? { body, duplex: "half" } : {}),
        signal: this.#controller.signal,
      } as RequestInit & { duplex?: "half" });
    } catch (error) {
      this.#failBeforeDispatch(error);
      return;
    }
    this.#touch();
    let handler: HttpServerHandler;
    try {
      handler = handlerFor(binding.server as NodeStyleHttpServer);
    } catch (error) {
      this.#failBeforeDispatch(error);
      return;
    }
    if (typeof handler.fetch !== "function") {
      this.#failBeforeDispatch(
        networkError(
          "ERR_HTTP_SERVER_HANDLER_UNAVAILABLE",
          "Workerd HTTP handler has no fetch method",
        ),
      );
      return;
    }
    const removeRequestCancellation = attachRequestCancellation(
      binding.server as NodeStyleHttpServer,
      request,
      requestMarker,
    );
    let responsePromise: Response | Promise<Response>;
    try {
      responsePromise = handler.fetch(request, env, ctx);
    } catch (error) {
      removeRequestCancellation();
      this.#failBeforeDispatch(error);
      return;
    }
    void Promise.resolve(responsePromise)
      .then(
        (response) => {
          if (this.destroyed) {
            if (response.body) void response.body.cancel().catch(() => {});
            return;
          }
          const incoming = (this.#incoming = new LocalIncomingMessage(
            response,
            method,
            parsed.path,
            () => this.#touch(),
          ));
          this.once("close", () => {
            if (!incoming.complete) incoming.destroy(networkError("ECONNRESET", "aborted"));
          });
          incoming.once("end", () => {
            this.#touch();
            this.destroy();
          });
          incoming.once("error", (incomingError) => {
            if (!this.destroyed) this.destroy(incomingError);
          });
          if (!this.emit("response", incoming)) incoming.resume();
        },
        (error: unknown) => this.#failBeforeDispatch(error),
      )
      .finally(() => {
        removeRequestCancellation();
      });
  }

  #failBeforeDispatch(error: unknown): void {
    const failure = error instanceof Error ? error : networkError("ERR_NETWORK", String(error));
    void this.#writer?.abort(failure).catch(() => {});
    queueMicrotask(() => {
      if (!this.destroyed) this.destroy(failure);
    });
  }

  #touch(): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (!this.#timeoutMs || this.destroyed) return;
    this.#timeout = setTimeout(() => this.emit("timeout"), this.#timeoutMs);
  }
}

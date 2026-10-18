// @effect-diagnostics nodeBuiltinImport:off - Facet servers extend host Node classes to preserve their public event and listen behavior.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { LoopbackRegistry, type LoopbackListener } from "./LoopbackRegistry.ts";
import { isAddressInUse, networkError, unsupportedNetworkOperation } from "./errors.ts";
import { patchResponseHeaders } from "./HttpResponseHeaders.ts";
import { hasTlsHandshakeOptions } from "./tlsOptions.ts";

type ListenOptions = Record<string, unknown> & { port?: number | string; host?: string };

type HttpServerLike = {
  readonly listening: boolean;
  listen(...args: unknown[]): unknown;
  close(...args: unknown[]): unknown;
  address(): { readonly port?: number | null } | string | null;
  emit(event: string, ...args: unknown[]): boolean;
};

interface ParsedListenArgs {
  readonly options: ListenOptions;
  readonly callback: ((...args: unknown[]) => void) | undefined;
}

type HttpIncomingMessageConstructor = typeof NodeHttp.IncomingMessage;
type HttpServerResponseConstructor = typeof NodeHttp.ServerResponse<NodeHttp.IncomingMessage>;
type HttpRequestListener = NodeHttp.RequestListener<
  HttpIncomingMessageConstructor,
  HttpServerResponseConstructor
>;
type HttpServerOptions = NodeHttp.ServerOptions<
  HttpIncomingMessageConstructor,
  HttpServerResponseConstructor
>;
type HttpsServerOptions = NodeHttps.ServerOptions<
  HttpIncomingMessageConstructor,
  HttpServerResponseConstructor
>;
type HttpServerArguments =
  | [requestListener?: HttpRequestListener]
  | [options: HttpServerOptions, requestListener?: HttpRequestListener];
type HttpsServerArguments =
  | [requestListener?: HttpRequestListener]
  | [options: HttpsServerOptions, requestListener?: HttpRequestListener];

function parseListenArgs(args: readonly unknown[]): ParsedListenArgs {
  const last = args.at(-1);
  const callback = typeof last === "function" ? (last as (...args: unknown[]) => void) : undefined;
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { options: { ...(first as Record<string, unknown>) }, callback };
  }
  const options: ListenOptions = {};
  if (typeof first !== "function" && first !== undefined) options.port = first as number | string;
  if (typeof args[1] === "string") options.host = args[1];
  if (typeof args[2] === "number") options.backlog = args[2];
  return { options, callback };
}

function validatedPort(value: unknown): number {
  const port =
    value === undefined
      ? 0
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw networkError(
      "ERR_SOCKET_BAD_PORT",
      `options.port must be an integer between 0 and 65535. Received ${String(value)}`,
    );
  }
  return port;
}

function bindNativeHttpServer(
  server: HttpServerLike,
  registry: LoopbackRegistry,
  protocol: "http" | "https",
  args: readonly unknown[],
  nativeListen: (options: ListenOptions, callback?: (...args: unknown[]) => void) => void,
  getBinding: () => LoopbackListener | undefined,
  setBinding: (binding: LoopbackListener | undefined) => void,
): HttpServerLike {
  if (server.listening || getBinding()) {
    throw networkError(
      "ERR_SERVER_ALREADY_LISTEN",
      "Listen method has been called more than once without closing.",
    );
  }
  const parsed = parseListenArgs(args);
  const requestedPort = validatedPort(parsed.options.port);
  const host = typeof parsed.options.host === "string" ? parsed.options.host : "127.0.0.1";
  if (
    parsed.options.path !== undefined ||
    parsed.options.fd !== undefined ||
    parsed.options.handle !== undefined
  ) {
    throw unsupportedNetworkOperation("HTTP server path, fd, and handle listening");
  }
  if (parsed.options.reusePort === true)
    throw unsupportedNetworkOperation("reusePort HTTP listeners");
  const excluded = new Set<number>();
  while (true) {
    let binding: LoopbackListener;
    try {
      binding = registry.reserve(requestedPort, protocol, server, host, excluded);
    } catch (error) {
      if (isAddressInUse(error)) {
        queueMicrotask(() => server.emit("error", error));
        return server;
      }
      throw error;
    }
    try {
      nativeListen({ ...parsed.options, port: binding.port }, parsed.callback);
      setBinding(binding);
      return server;
    } catch (error) {
      registry.release(binding);
      if (requestedPort === 0 && isAddressInUse(error)) {
        excluded.add(binding.port);
        continue;
      }
      if (isAddressInUse(error)) {
        queueMicrotask(() => server.emit("error", error));
        return server;
      }
      throw error;
    }
  }
}

function closeNativeHttpServer(
  server: HttpServerLike,
  registry: LoopbackRegistry,
  args: readonly unknown[],
  getBinding: () => LoopbackListener | undefined,
  setBinding: (binding: LoopbackListener | undefined) => void,
  nativeClose: Function,
): HttpServerLike {
  const binding = getBinding();
  if (binding) {
    setBinding(undefined);
    registry.release(binding);
  }
  const callback = args[0];
  const wrapped =
    typeof callback === "function"
      ? (...callbackArgs: unknown[]) => {
          if (binding) registry.release(binding);
          Reflect.apply(callback, server, callbackArgs);
        }
      : undefined;
  Reflect.apply(nativeClose, server, wrapped ? [wrapped] : []);
  return server;
}

export interface HttpServerConstructors {
  readonly http: Function;
  readonly https: Function;
}

/** Build the two Node server classes over one registry without replacing workerd's HTTP parser. */
export function createHttpServerConstructors(registry: LoopbackRegistry): HttpServerConstructors {
  class FacetHttpServer extends NodeHttp.Server<
    HttpIncomingMessageConstructor,
    HttpServerResponseConstructor
  > {
    #binding: LoopbackListener | undefined;

    constructor(...args: HttpServerArguments) {
      if (args.length === 0) super();
      else if (args[0] === undefined) super(args[1]);
      else if (typeof args[0] === "function") super(args[0]);
      else super(args[0], args[1]);
      this.prependListener("request", (_incoming, outgoing) => patchResponseHeaders(outgoing));
    }

    override listen(...args: unknown[]): this {
      const nativeListen = (options: ListenOptions, callback?: (...args: unknown[]) => void) => {
        Reflect.apply(
          NodeHttp.Server.prototype.listen,
          this,
          callback ? [options, callback] : [options],
        );
      };
      return bindNativeHttpServer(
        this,
        registry,
        "http",
        args,
        nativeListen,
        () => this.#binding,
        (binding) => {
          this.#binding = binding;
        },
      ) as this;
    }

    override close(callback?: (error?: Error) => void): this {
      closeNativeHttpServer(
        this,
        registry,
        callback ? [callback] : [],
        () => this.#binding,
        (binding) => {
          this.#binding = binding;
        },
        NodeHttp.Server.prototype.close,
      );
      return this;
    }
  }

  class FacetHttpsServer extends NodeHttps.Server<
    HttpIncomingMessageConstructor,
    HttpServerResponseConstructor
  > {
    #binding: LoopbackListener | undefined;

    constructor(...args: HttpsServerArguments) {
      const options = args[0];
      if (typeof options === "object" && options !== null && hasTlsHandshakeOptions(options)) {
        throw unsupportedNetworkOperation("TLS server handshakes");
      }
      if (args.length === 0) super();
      else if (args[0] === undefined) super(args[1]);
      else if (typeof args[0] === "function") super(args[0]);
      else super(args[0], args[1]);
      this.prependListener("request", (_incoming, outgoing) => patchResponseHeaders(outgoing));
    }

    override listen(...args: unknown[]): this {
      const nativeListen = (options: ListenOptions, callback?: (...args: unknown[]) => void) => {
        Reflect.apply(
          NodeHttps.Server.prototype.listen,
          this,
          callback ? [options, callback] : [options],
        );
      };
      return bindNativeHttpServer(
        this,
        registry,
        "https",
        args,
        nativeListen,
        () => this.#binding,
        (binding) => {
          this.#binding = binding;
        },
      ) as this;
    }

    override close(callback?: (error?: Error) => void): this {
      closeNativeHttpServer(
        this,
        registry,
        callback ? [callback] : [],
        () => this.#binding,
        (binding) => {
          this.#binding = binding;
        },
        NodeHttps.Server.prototype.close,
      );
      return this;
    }
  }

  return Object.freeze({ http: FacetHttpServer, https: FacetHttpsServer });
}

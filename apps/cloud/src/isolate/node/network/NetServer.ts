import * as NodeEvents from "node:events";
import { LoopbackRegistry, type LoopbackListener } from "./LoopbackRegistry.ts";
import { parsePort } from "./address.ts";
import { connectionRefused, networkError, unsupportedNetworkOperation } from "./errors.ts";
import { createLoopbackTransportPair } from "./LoopbackTransport.ts";
import { attachSocketTransport, failSocket, LoopbackSocket } from "./LoopbackSocket.ts";

interface ListenOptions {
  readonly allowHalfOpen?: boolean;
  readonly port?: number | string;
  readonly host?: string;
  readonly path?: string;
  readonly reusePort?: boolean;
  readonly handle?: unknown;
  readonly fd?: number;
  readonly pauseOnConnect?: boolean;
  readonly highWaterMark?: number;
}

interface ServerLease {
  readonly sockets: Set<LoopbackSocket>;
  readonly callbacks: ((error?: Error | null) => void)[];
  closing: boolean;
  finished: boolean;
}

function parseListenArgs(args: readonly unknown[]): {
  readonly options: ListenOptions;
  readonly callback: ((...args: unknown[]) => void) | undefined;
} {
  const last = args.at(-1);
  const callback = typeof last === "function" ? (last as (...args: unknown[]) => void) : undefined;
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { options: { ...(first as ListenOptions) }, callback };
  }
  return {
    options: {
      ...(typeof first !== "function" && first !== undefined
        ? { port: first as number | string }
        : {}),
      ...(typeof args[1] === "string" ? { host: args[1] } : {}),
    },
    callback,
  };
}

export interface LoopbackNetServerFactory {
  readonly Server: Function;
  readonly createServer: (...args: unknown[]) => object;
  readonly acceptLocalConnection: (binding: LoopbackListener, client: LoopbackSocket) => void;
}

export function createLoopbackNetServerFactory(
  registry: LoopbackRegistry,
  createSocket: (options: { readonly allowHalfOpen?: boolean }) => LoopbackSocket = (options) =>
    new LoopbackSocket(options),
): LoopbackNetServerFactory {
  let nextClientPort = 65_535;
  const leases = new WeakMap<FacetNetServer, Map<LoopbackListener, ServerLease>>();
  const activeBindings = new WeakMap<FacetNetServer, LoopbackListener>();

  class FacetNetServer extends NodeEvents.EventEmitter {
    readonly allowHalfOpen: boolean;
    readonly pauseOnConnect: boolean;
    readonly highWaterMark: number | undefined;
    maxConnections: number | undefined;

    constructor(
      options?:
        | {
            readonly allowHalfOpen?: boolean;
            readonly pauseOnConnect?: boolean;
            readonly highWaterMark?: number;
          }
        | ((socket: LoopbackSocket) => void),
      connectionListener?: (socket: LoopbackSocket) => void,
    ) {
      super();
      if (typeof options === "function") {
        connectionListener = options;
        options = {};
      }
      this.allowHalfOpen = options?.allowHalfOpen ?? false;
      this.pauseOnConnect = Boolean(options?.pauseOnConnect);
      this.highWaterMark = options?.highWaterMark;
      if (connectionListener) this.on("connection", connectionListener);
      leases.set(this, new Map());
    }

    get listening(): boolean {
      return activeBindings.has(this);
    }

    get connections(): number {
      return [...leases.get(this)!.values()].reduce(
        (count, lease) => count + lease.sockets.size,
        0,
      );
    }

    listen(...args: unknown[]): this {
      if (this.listening)
        throw networkError(
          "ERR_SERVER_ALREADY_LISTEN",
          "Listen method has been called more than once without closing.",
        );
      const parsed = parseListenArgs(args);
      if (
        parsed.options.path !== undefined ||
        parsed.options.handle !== undefined ||
        parsed.options.fd !== undefined
      ) {
        throw unsupportedNetworkOperation("Unix domain socket and handle listening");
      }
      if (parsed.options.reusePort) throw unsupportedNetworkOperation("reusePort listeners");
      const port = parsePort(parsed.options.port, 0);
      const host = parsed.options.host ?? "0.0.0.0";
      let binding: LoopbackListener;
      try {
        binding = registry.reserve(port, "net", this, host);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "code") === "EADDRINUSE"
        ) {
          queueMicrotask(() => this.emit("error", error));
          return this;
        }
        throw error;
      }
      activeBindings.set(this, binding);
      const lease: ServerLease = {
        sockets: new Set(),
        callbacks: [],
        closing: false,
        finished: false,
      };
      if (parsed.callback) this.once("listening", parsed.callback);
      leases.get(this)!.set(binding, lease);
      queueMicrotask(() => {
        if (activeBindings.get(this) === binding) this.emit("listening");
      });
      return this;
    }

    address(): { address: string; family: string; port: number } | null {
      const binding = activeBindings.get(this);
      if (!binding) return null;
      return {
        address: binding.address,
        family: binding.address.includes(":") ? "IPv6" : "IPv4",
        port: binding.port,
      };
    }

    close(callback?: (error?: Error | null) => void): this {
      const binding = activeBindings.get(this);
      if (!binding) {
        const error = networkError("ERR_SERVER_NOT_RUNNING", "Server is not running");
        queueMicrotask(() => {
          if (callback) callback(error);
          else this.emit("error", error);
        });
        return this;
      }
      activeBindings.delete(this);
      registry.release(binding);
      const lease = leases.get(this)!.get(binding)!;
      lease.closing = true;
      if (callback) lease.callbacks.push(callback);
      if (lease.sockets.size === 0) queueMicrotask(() => finishClose(this, binding, lease));
      return this;
    }

    closeAllConnections(): void {
      for (const lease of leases.get(this)!.values()) {
        for (const socket of lease.sockets) socket.destroy();
      }
    }

    closeIdleConnections(): void {}

    getConnections(callback: (error: Error | null, count: number) => void): this {
      queueMicrotask(() => callback(null, this.connections));
      return this;
    }

    ref(): this {
      return this;
    }
    unref(): this {
      return this;
    }
  }

  function finishClose(
    server: FacetNetServer,
    binding: LoopbackListener,
    lease: ServerLease,
  ): void {
    if (!lease.closing || lease.finished || lease.sockets.size > 0) return;
    lease.finished = true;
    leases.get(server)?.delete(binding);
    server.emit("close");
    for (const callback of lease.callbacks.splice(0)) callback(null);
  }

  function acceptLocalConnection(binding: LoopbackListener, client: LoopbackSocket): void {
    const server = binding.server as FacetNetServer;
    const lease = leases.get(server)?.get(binding);
    if (
      !lease ||
      lease.closing ||
      activeBindings.get(server) !== binding ||
      registry.get(binding.port) !== binding
    ) {
      failSocket(client, connectionRefused(binding.address, binding.port));
      return;
    }
    nextClientPort = nextClientPort === 49_152 ? 65_535 : nextClientPort - 1;
    const [clientTransport, serverTransport] = createLoopbackTransportPair({
      localAddress: "127.0.0.1",
      localPort: nextClientPort,
      remoteAddress: "127.0.0.1",
      remotePort: binding.port,
    });
    const serverSocket = createSocket({ allowHalfOpen: server.allowHalfOpen });
    attachSocketTransport(serverSocket, { ...serverTransport, localAddress: binding.address });
    lease.sockets.add(serverSocket);
    serverSocket.once("close", () => {
      lease.sockets.delete(serverSocket);
      if (lease.closing) finishClose(server, binding, lease);
    });
    if (server.maxConnections !== undefined && server.connections > server.maxConnections) {
      server.emit("drop", { localAddress: binding.address, localPort: binding.port });
      serverSocket.destroy();
      failSocket(client, connectionRefused(binding.address, binding.port));
      return;
    }
    server.emit("connection", serverSocket);
    attachSocketTransport(client, clientTransport, { emitConnect: true });
  }

  const createServer = (...args: unknown[]): object => Reflect.construct(FacetNetServer, args);
  return Object.freeze({ Server: FacetNetServer, createServer, acceptLocalConnection });
}

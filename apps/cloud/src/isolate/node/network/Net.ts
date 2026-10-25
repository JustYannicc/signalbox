import * as NodeNet from "node:net";
import { LoopbackRegistry } from "./LoopbackRegistry.ts";
import { createLoopbackNetServerFactory } from "./NetServer.ts";
import { copyNativeExports, defineDefault } from "./moduleExports.ts";
import { authorityHost, isLocalHost, parsePort, parseSocketAddress } from "./address.ts";
import { connectionRefused, networkError, unsupportedNetworkOperation } from "./errors.ts";
import type { DuplexTransport } from "./LoopbackTransport.ts";
import { attachSocketTransport, failSocket, LoopbackSocket } from "./LoopbackSocket.ts";

export interface NativeSocketConnection {
  readonly opened: Promise<{
    readonly localAddress?: string | null;
    readonly remoteAddress?: string | null;
  }>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

export type NativeSocketConnect = (
  address: string,
  options: { readonly secureTransport: "off"; readonly allowHalfOpen: boolean },
) => NativeSocketConnection;

interface ConnectOptions {
  readonly allowHalfOpen?: boolean;
  readonly port?: number | string;
  readonly host?: string;
  readonly path?: string;
  readonly localAddress?: string;
  readonly localPort?: number;
  readonly lookup?: unknown;
  readonly signal?: AbortSignal;
}

function parseConnectArgs(args: readonly unknown[]): { readonly options: ConnectOptions } {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { options: { ...(first as ConnectOptions) } };
  }
  return {
    options: {
      ...(first === undefined || typeof first === "function"
        ? {}
        : { port: first as number | string }),
      ...(typeof args[1] === "string" ? { host: args[1] } : {}),
    },
  };
}

function systemError(error: unknown, port: number): Error {
  if (typeof error === "object" && error !== null) return error as Error;
  return networkError("ERR_NETWORK", `Network operation failed on port ${port}: ${String(error)}`);
}

function closeNativeConnection(connection: NativeSocketConnection): void {
  try {
    void Promise.resolve(connection.close()).catch(() => {});
  } catch {}
}

export function createNetModule(
  registry: LoopbackRegistry,
  connectNativeSocket: NativeSocketConnect,
): object {
  class FacetSocket extends LoopbackSocket {
    constructor(options: { readonly allowHalfOpen?: boolean } = {}) {
      super({
        ...(options.allowHalfOpen === undefined ? {} : { allowHalfOpen: options.allowHalfOpen }),
        connect: connectSocket,
      });
    }
  }

  function UnsupportedBoundSocket(..._args: unknown[]): never {
    throw unsupportedNetworkOperation("net.BoundSocket handles");
  }

  const serverFactory = createLoopbackNetServerFactory(
    registry,
    (options) => new FacetSocket(options),
  );

  function connectSocket(socket: LoopbackSocket, args: readonly unknown[]): void {
    const options = parseConnectArgs(args).options;
    if (options.signal !== undefined) {
      if (!(options.signal instanceof AbortSignal)) {
        failSocket(
          socket,
          networkError("ERR_INVALID_ARG_TYPE", "options.signal must be an AbortSignal"),
        );
        return;
      }
      const abort = () => socket.destroy(networkError("ABORT_ERR", "The operation was aborted"));
      if (options.signal.aborted) {
        failSocket(socket, networkError("ABORT_ERR", "The operation was aborted"));
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => options.signal?.removeEventListener("abort", abort));
    }
    if (options.path !== undefined) {
      failSocket(socket, unsupportedNetworkOperation("Unix domain socket connections"));
      return;
    }
    if (
      options.lookup !== undefined ||
      options.localAddress !== undefined ||
      options.localPort !== undefined
    ) {
      failSocket(socket, unsupportedNetworkOperation("Custom DNS lookup and local TCP binding"));
      return;
    }
    let port: number;
    try {
      port = parsePort(options.port, 0);
      if (port === 0) throw networkError("ERR_SOCKET_BAD_PORT", "A destination port is required");
    } catch (error) {
      failSocket(socket, error);
      return;
    }
    const host = options.host ?? "localhost";
    if (isLocalHost(host)) {
      queueMicrotask(() => {
        if (socket.destroyed) return;
        const binding = registry.get(port);
        if (!binding) {
          failSocket(socket, connectionRefused(host, port));
          return;
        }
        if (binding.protocol !== "net") {
          failSocket(
            socket,
            unsupportedNetworkOperation(`Raw net.connect to ${binding.protocol}.Server`),
          );
          return;
        }
        serverFactory.acceptLocalConnection(binding, socket);
      });
      return;
    }
    void connectNative(host, port, Boolean(options.allowHalfOpen), socket);
  }

  function connectNative(
    host: string,
    port: number,
    allowHalfOpen: boolean,
    socket: LoopbackSocket,
  ): void {
    try {
      const connection = connectNativeSocket(`${authorityHost(host)}:${port}`, {
        secureTransport: "off",
        allowHalfOpen,
      });
      let attached = false;
      let closed = false;
      const closeConnection = () => {
        if (closed) return;
        closed = true;
        closeNativeConnection(connection);
      };
      const closeBeforeOpen = () => {
        if (!attached) closeConnection();
      };
      socket.once("close", closeBeforeOpen);
      void connection.opened.then(
        (opened) => {
          if (socket.destroyed) {
            socket.removeListener("close", closeBeforeOpen);
            closeConnection();
            return;
          }
          attached = true;
          socket.removeListener("close", closeBeforeOpen);
          const local = parseSocketAddress(opened.localAddress);
          const remote = parseSocketAddress(opened.remoteAddress);
          const transport: DuplexTransport = {
            readable: connection.readable,
            writable: connection.writable,
            ...(local.address === undefined ? {} : { localAddress: local.address }),
            ...(local.port === undefined ? {} : { localPort: local.port }),
            remoteAddress: remote.address ?? host,
            remotePort: remote.port ?? port,
            close: closeConnection,
          };
          attachSocketTransport(socket, transport, { emitConnect: true });
        },
        (error: unknown) => {
          socket.removeListener("close", closeBeforeOpen);
          closeConnection();
          failSocket(socket, systemError(error, port));
        },
      );
    } catch (error) {
      failSocket(socket, systemError(error, port));
    }
  }

  const createConnection = (...args: unknown[]): LoopbackSocket => {
    const options = parseConnectArgs(args).options;
    const socket = new FacetSocket(
      options.allowHalfOpen === undefined ? {} : { allowHalfOpen: options.allowHalfOpen },
    );
    socket.connect(...args);
    return socket;
  };

  const module = copyNativeExports(NodeNet);
  Object.assign(module, {
    Server: serverFactory.Server,
    Socket: FacetSocket,
    Stream: FacetSocket,
    BoundSocket: UnsupportedBoundSocket,
    createServer: serverFactory.createServer,
    connect: createConnection,
    createConnection,
  });
  return defineDefault(module);
}

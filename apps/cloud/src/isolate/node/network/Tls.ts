import * as NodeTls from "node:tls";
import { isLocalHost } from "./address.ts";
import { unsupportedNetworkOperation } from "./errors.ts";
import { LoopbackSocket } from "./LoopbackSocket.ts";
import { copyNativeExports, defineDefault } from "./moduleExports.ts";

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function connectionOptions(args: readonly unknown[]): Record<string, unknown> {
  const first = args[0];
  if (first instanceof LoopbackSocket) return { socket: first };
  if (isOptions(first)) return first;
  if (typeof first === "number" || (typeof first === "string" && Number(first) >= 0)) {
    const positional: Record<string, unknown> = { port: first };
    let options: unknown;
    if (typeof args[1] === "string") {
      positional.host = args[1];
      options = args[2];
    } else {
      options = isOptions(args[1]) ? args[1] : args[2];
    }
    return isOptions(options) ? { ...positional, ...options } : positional;
  }
  if (typeof first === "string") return { path: first, ...(isOptions(args[1]) ? args[1] : {}) };
  return {};
}

function tlsTarget(options: Record<string, unknown>): {
  readonly host: string;
  readonly local: boolean;
} {
  const socket = options.socket;
  if (socket instanceof LoopbackSocket) return { host: "localhost", local: true };
  const socketHost =
    typeof socket === "object" && socket !== null
      ? Reflect.get(socket, "remoteAddress")
      : undefined;
  if (typeof socketHost === "string") return { host: socketHost, local: isLocalHost(socketHost) };
  if (typeof options.path === "string" && options.path.length > 0)
    return { host: "localhost", local: true };
  const host =
    typeof options.host === "string"
      ? options.host
      : typeof options.hostname === "string"
        ? options.hostname
        : "localhost";
  return { host, local: isLocalHost(host) };
}

export function createTlsModule(): object {
  const module = copyNativeExports(NodeTls);
  const nativeConnect = Reflect.get(NodeTls, "connect");
  const connect = (...args: unknown[]): unknown => {
    const options = connectionOptions(args);
    const existingSocket = options.socket;
    if (existingSocket instanceof LoopbackSocket) {
      throw unsupportedNetworkOperation("TLS upgrades over existing Node sockets");
    }
    const target = tlsTarget(options);
    if (target.local) throw unsupportedNetworkOperation("TLS handshakes to loopback listeners");
    if (typeof nativeConnect !== "function")
      throw unsupportedNetworkOperation("TLS client connections");
    return Reflect.apply(nativeConnect, NodeTls, args);
  };
  function UnsupportedTlsServer(..._args: unknown[]): never {
    throw unsupportedNetworkOperation("TLS server handshakes");
  }
  Object.assign(module, {
    connect,
    Server: UnsupportedTlsServer,
    createServer: (..._args: unknown[]) => {
      throw unsupportedNetworkOperation("TLS server handshakes");
    },
  });
  return defineDefault(module);
}

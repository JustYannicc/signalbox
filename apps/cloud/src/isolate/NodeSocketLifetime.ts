// @effect-diagnostics nodeBuiltinImport:off - Async context binds native sockets to the request that created them.
import * as NodeAsyncHooks from "node:async_hooks";
import type * as NodeNet from "node:net";
import { networkError } from "./node/network/errors.ts";

interface SocketOwner {
  capture(socket: NodeNet.Socket): void;
}
const current = new NodeAsyncHooks.AsyncLocalStorage<SocketOwner>();

function isSocket(value: unknown): value is NodeNet.Socket {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "destroy") === "function" &&
    typeof Reflect.get(value, "once") === "function"
  );
}

export function observeNodeSocket<T>(socket: T): T {
  const owner = current.getStore();
  if (owner && isSocket(socket)) owner.capture(socket);
  return socket;
}

export function createNodeSocketLifetime() {
  const sockets = new Set<NodeNet.Socket>();
  const closed = new Set<Promise<void>>();
  let stopping = false;
  const cancel = (socket: NodeNet.Socket) =>
    socket.destroy(networkError("ECONNRESET", "Proxy transport stopped"));
  const owner: SocketOwner = {
    capture(socket) {
      if (sockets.has(socket)) return;
      sockets.add(socket);
      const closure = socket.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => socket.once("close", resolve));
      closed.add(closure);
      void closure.then(() => {
        sockets.delete(socket);
        closed.delete(closure);
      });
      if (stopping) cancel(socket);
    },
  };
  return {
    run<T>(operation: () => T): T {
      return current.run(owner, operation);
    },
    capture: owner.capture,
    abort() {
      stopping = true;
      for (const socket of sockets) cancel(socket);
    },
    async join() {
      while (closed.size) await Promise.all(closed);
    },
  };
}

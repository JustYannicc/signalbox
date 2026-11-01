// @effect-diagnostics nodeBuiltinImport:off - Route the real proxy library through the production native socket guards.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeModule from "node:module";
import * as Undici from "undici";
import {
  createWorkerdNodeBuiltinFailures,
  DEFAULT_NODE_NATIVE_MODULES,
} from "../../NodeNativeModules.ts";
import { configureNodeHttpAgents } from "../../../isolate/NodeHttpAgent.ts";

export function installProxyRuntime() {
  // Capture the native functions before replacing the CJS imports used by HttpsProxyAgent.
  const guarded = createWorkerdNodeBuiltinFailures(DEFAULT_NODE_NATIVE_MODULES);
  const http = guarded.http as typeof NodeHttp;
  const https = guarded.https as typeof NodeHttps;
  configureNodeHttpAgents([http, https], () => Undici);
  const sockets: NodeNet.Socket[] = [];
  const restore: Array<() => void> = [];
  const require = NodeModule.createRequire(import.meta.url);
  for (const name of ["net", "tls"] as const) {
    const native: object = require(`node:${name}`);
    const descriptor = Object.getOwnPropertyDescriptor(native, "connect");
    const connect: unknown = Reflect.get(guarded[name]!, "connect");
    if (!descriptor || typeof connect !== "function") throw new Error(`Missing ${name}.connect`);
    Object.defineProperty(native, "connect", {
      ...descriptor,
      value: (...args: unknown[]) => {
        const socket = Reflect.apply(connect, native, args) as NodeNet.Socket;
        // Node validates TLS through these public methods; Workerd validates internally.
        // Restore the production guards before guest secureConnect listeners run.
        if (name === "tls") {
          const methods = ["getEphemeralKeyInfo", "isSessionReused", "getPeerCertificate"] as const;
          const guards = methods.map(
            (method) => [method, Object.getOwnPropertyDescriptor(socket, method)!] as const,
          );
          for (const method of methods)
            Object.defineProperty(socket, method, {
              value: NodeTls.TLSSocket.prototype[method],
              configurable: true,
            });
          socket.prependOnceListener("secureConnect", () => {
            for (const [method, guard] of guards) Object.defineProperty(socket, method, guard);
          });
        }
        sockets.push(socket);
        return socket;
      },
    });
    restore.push(() => Object.defineProperty(native, "connect", descriptor));
  }
  return {
    http,
    https,
    sockets,
    restore: () => {
      for (const reset of restore) reset();
    },
  };
}

// @effect-diagnostics nodeBuiltinImport:off - This compatibility layer builds the host Node modules exposed to generated user code.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { LoopbackRegistry } from "./node/network/LoopbackRegistry.ts";
import { createHttpClientExports } from "./node/network/HttpClient.ts";
import type { HttpServerHandlerFactory } from "./node/network/HttpClientTypes.ts";
import {
  createHttpServerConstructors,
  type HttpServerConstructors,
} from "./node/network/HttpServer.ts";
import { createNetModule, type NativeSocketConnect } from "./node/network/Net.ts";
import { createTlsModule } from "./node/network/Tls.ts";
import { copyNativeExports, defineDefault } from "./node/network/moduleExports.ts";

export { LoopbackRegistry } from "./node/network/LoopbackRegistry.ts";

export interface NodeNetworkHost {
  /** Workerd's public `httpServerHandler` from `cloudflare:node`. */
  readonly httpServerHandler: HttpServerHandlerFactory;
  /** Workerd's public `connect` from `cloudflare:sockets`. */
  readonly connectSocket: NativeSocketConnect;
  readonly env?: unknown;
  readonly ctx?: unknown;
}

export type NodeNetworkModules = Readonly<Record<"http" | "https" | "net" | "tls", object>>;

function createHttpModule(
  protocol: "http" | "https",
  native: object,
  server: HttpServerConstructors["http"] | HttpServerConstructors["https"],
  registry: LoopbackRegistry,
  handlerFor: HttpServerHandlerFactory,
  env: unknown,
  ctx: unknown,
): object {
  const module = copyNativeExports(native);
  const client = createHttpClientExports(protocol, registry, handlerFor, env, ctx, native);
  Object.assign(module, {
    Server: server,
    request: client.request,
    get: client.get,
    createServer: (...args: unknown[]) => Reflect.construct(server, args),
  });
  return defineDefault(module);
}

/** Create one host-scoped network surface; all four builtins share its listener registry. */
export function createNodeNetworkModules(host: NodeNetworkHost): NodeNetworkModules {
  if (typeof host.httpServerHandler !== "function" || typeof host.connectSocket !== "function") {
    throw new TypeError("Node network requires the host HTTP dispatcher and socket connector");
  }
  const registry = new LoopbackRegistry();
  const servers = createHttpServerConstructors(registry);
  const net = createNetModule(registry, host.connectSocket);
  const http = createHttpModule(
    "http",
    NodeHttp,
    servers.http,
    registry,
    host.httpServerHandler,
    host.env,
    host.ctx,
  );
  const https = createHttpModule(
    "https",
    NodeHttps,
    servers.https,
    registry,
    host.httpServerHandler,
    host.env,
    host.ctx,
  );
  const tls = createTlsModule();
  return Object.freeze({ http, https, net, tls });
}

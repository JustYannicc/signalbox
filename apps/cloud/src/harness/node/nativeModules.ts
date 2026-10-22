// @effect-diagnostics nodeBuiltinImport:off - The Node personality exposes the platform's native modules alongside process-owned adapters.
import * as NodeAssert from "node:assert";
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeCrypto from "node:crypto";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeHttps from "node:https";
import * as NodeInspector from "node:inspector";
import * as NodeNet from "node:net";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeQuerystring from "node:querystring";
import * as NodeStream from "node:stream";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStreamWeb from "node:stream/web";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeUtilTypes from "node:util/types";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeZlib from "node:zlib";
import { createNodeAsyncHooks } from "../../isolate/NodeAsyncHooks.ts";
import { createNodeInspectorModule } from "../../isolate/NodeInspector.ts";
import { nodeTlsModule } from "../../isolate/NodeTls.ts";

function nativeModule(namespace: object): object {
  const value: unknown = Reflect.get(namespace, "default") ?? namespace;
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("Native builtin does not export a module object");
  }
  return value;
}

const nativeModules: Record<string, object> = Object.fromEntries(
  Object.entries({
    assert: NodeAssert,
    async_hooks: createNodeAsyncHooks(),
    buffer: NodeBuffer,
    constants: NodeConstants,
    crypto: NodeCrypto,
    diagnostics_channel: NodeDiagnosticsChannel,
    events: NodeEvents,
    http: NodeHttp,
    http2: NodeHttp2,
    https: NodeHttps,
    inspector: NodeInspector,
    net: NodeNet,
    perf_hooks: NodePerfHooks,
    querystring: NodeQuerystring,
    stream: NodeStream,
    "stream/consumers": NodeStreamConsumers,
    "stream/promises": NodeStreamPromises,
    "stream/web": NodeStreamWeb,
    string_decoder: NodeStringDecoder,
    timers: NodeTimers,
    "timers/promises": NodeTimersPromises,
    tls: nodeTlsModule(),
    url: NodeURL,
    util: NodeUtil,
    "util/types": NodeUtilTypes,
    v8: NodeV8,
    vm: NodeVM,
    worker_threads: NodeWorkerThreads,
    zlib: NodeZlib,
  }).map(([name, namespace]) => [name, nativeModule(namespace)]),
);

nativeModules.inspector = createNodeInspectorModule(nativeModule(NodeInspector));

export const DEFAULT_NODE_NATIVE_MODULES = Object.freeze(nativeModules);

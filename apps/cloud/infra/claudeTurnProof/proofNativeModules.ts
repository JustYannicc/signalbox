// @effect-diagnostics nodeBuiltinImport:off - diagnostic native fallback, independent from the release's facades.
import * as NodeAssert from "node:assert";
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDns from "node:dns";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeTls from "node:tls";
import * as NodeTty from "node:tty";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeUtilTypes from "node:util/types";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeZlib from "node:zlib";

function nativeModule(namespace: object): object {
  const value: unknown = Reflect.get(namespace, "default") ?? namespace;
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("Native builtin does not export a module object");
  }
  return value;
}

// These fallbacks establish diagnostic reach only, not supported Node semantics.
export function getNativeHostModules() {
  return Object.fromEntries(
    Object.entries({
      assert: NodeAssert,
      async_hooks: NodeAsyncHooks,
      buffer: NodeBuffer,
      child_process: NodeChildProcess,
      crypto: NodeCrypto,
      dns: NodeDns,
      "dns/promises": NodeDnsPromises,
      events: NodeEvents,
      http: NodeHttp,
      http2: NodeHttp2,
      https: NodeHttps,
      net: NodeNet,
      perf_hooks: NodePerfHooks,
      readline: NodeReadline,
      stream: NodeStream,
      "stream/consumers": NodeStreamConsumers,
      "stream/promises": NodeStreamPromises,
      string_decoder: NodeStringDecoder,
      "timers/promises": NodeTimersPromises,
      tls: NodeTls,
      tty: NodeTty,
      url: NodeURL,
      util: NodeUtil,
      "util/types": NodeUtilTypes,
      v8: NodeV8,
      vm: NodeVM,
      worker_threads: NodeWorkerThreads,
      zlib: NodeZlib,
    }).map(([name, namespace]) => [name, nativeModule(namespace)]),
  );
}

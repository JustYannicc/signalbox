import { createUnsupportedNodeBuiltin } from "../../isolate/NodeBuiltinFailure.ts";
import { createNodeHttpAgentModules } from "../../isolate/NodeHttpAgent.ts";
import { createNodeDebuglog } from "../../isolate/NodeDebuglog.ts";
import { guardWorkerdNativeOptions } from "./nativeOptionGuards.ts";
import { createWorkerdAsyncResource } from "../../isolate/NodeAsyncResource.ts";
import type * as NodeAsyncHooks from "node:async_hooks";
import { overrideNativeModule } from "./nativeModuleOverrides.ts";

// These Workerd exports throw, return placeholders, or are absent. Never report success
// until a real implementation replaces the corresponding adapter.
const unsupported = {
  http: ["Server", "createServer"],
  https: ["Server", "createServer"],
  net: ["Server", "createServer"],
  http2: ["connect"],
  perf_hooks: ["monitorEventLoopDelay"],
  tls: ["createSecureContext", "setDefaultCACertificates"],
  util: ["getSystemErrorName"],
  v8: ["getHeapSpaceStatistics", "getHeapStatistics"],
  vm: [
    "Script",
    "SourceTextModule",
    "SyntheticModule",
    "createContext",
    "isContext",
    "runInContext",
    "runInThisContext",
  ],
} as const;

export function createWorkerdNodeBuiltinFailures(modules: Readonly<Record<string, object>>) {
  const result = { ...modules };
  for (const [specifier, members] of Object.entries(unsupported)) {
    const native = modules[specifier];
    if (native === undefined) throw new TypeError(`Missing Workerd builtin module: ${specifier}`);
    const replacements: Record<string, unknown> = {};
    for (const member of members) {
      replacements[member] = createUnsupportedNodeBuiltin(
        `${specifier}.${member}`,
        `The Workerd ${specifier}.${member} adapter is unavailable; calling it throws a named error. This remains an open implementation obligation.`,
      );
    }
    result[specifier] = overrideNativeModule(native, replacements);
  }
  const util = result.util;
  if (util !== undefined) {
    const format: unknown = Reflect.get(util, "format");
    if (typeof format !== "function") throw new TypeError("Missing native util.format");
    const debuglog = createNodeDebuglog(
      (...args) => String(Reflect.apply(format, util, args)),
      () => globalThis.process,
    );
    Object.defineProperties(util, {
      debuglog: { value: debuglog, configurable: true, writable: true, enumerable: true },
      debug: { value: debuglog, configurable: true, writable: true, enumerable: true },
    });
  }
  const hooks = result.async_hooks;
  if (!hooks) throw new TypeError("Missing Workerd async_hooks");
  const AsyncResource: typeof NodeAsyncHooks.AsyncResource = Reflect.get(hooks, "AsyncResource");
  result.async_hooks = overrideNativeModule(hooks, {
    AsyncResource: createWorkerdAsyncResource(AsyncResource),
  });
  guardWorkerdNativeOptions(result);
  const clients = createNodeHttpAgentModules({ http: modules.http!, https: modules.https! });
  for (const protocol of ["http", "https"] as const)
    result[protocol] = overrideNativeModule(result[protocol]!, clients[protocol]);
  return result;
}

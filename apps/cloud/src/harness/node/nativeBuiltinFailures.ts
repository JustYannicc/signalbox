import { createUnsupportedNodeBuiltin } from "../../isolate/NodeBuiltinFailure.ts";

// These Workerd exports throw, return placeholders, or are absent. Never report success
// until a real implementation replaces the corresponding adapter.
const unsupported = {
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
    "runInContext",
    "runInThisContext",
  ],
} as const;

export function createWorkerdNodeBuiltinFailures(modules: Readonly<Record<string, object>>) {
  const result = { ...modules };
  for (const [specifier, members] of Object.entries(unsupported)) {
    const native = modules[specifier];
    if (native === undefined) throw new TypeError(`Missing Workerd builtin module: ${specifier}`);
    const descriptors = Object.getOwnPropertyDescriptors(native);
    for (const member of members) {
      descriptors[member] = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createUnsupportedNodeBuiltin(
          `${specifier}.${member}`,
          `The Workerd ${specifier}.${member} adapter is unavailable; calling it throws a named error. This remains an open implementation obligation.`,
        ),
      };
    }
    result[specifier] = Object.create(Object.getPrototypeOf(native), descriptors) as object;
  }
  return result;
}

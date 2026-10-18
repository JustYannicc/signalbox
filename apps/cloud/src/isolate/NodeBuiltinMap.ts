// Routing intent only. These destinations do not establish callable support.
export const NODE_BUILTIN_ROUTES = {
  assert: "workerd",
  async_hooks: "workerd",
  buffer: "workerd",
  child_process: "kernel-process",
  console: "workerd-partial",
  constants: "facet-context",
  crypto: "workerd",
  diagnostics_channel: "workerd",
  dns: "workerd",
  "dns/promises": "workerd",
  events: "workerd",
  fs: "kernel-filesystem",
  "fs/promises": "kernel-filesystem",
  http: "workerd-and-loopback",
  http2: "workerd-constants-only",
  https: "workerd-and-loopback",
  inspector: "workerd-partial",
  module: "module-graph",
  net: "workerd-and-loopback",
  os: "facet-context",
  path: "facet-context",
  "path/posix": "facet-context",
  "path/win32": "workerd",
  perf_hooks: "workerd-partial",
  process: "facet-context",
  querystring: "workerd",
  readline: "workerd",
  stream: "workerd",
  "stream/consumers": "workerd",
  "stream/promises": "workerd",
  string_decoder: "workerd",
  timers: "workerd",
  "timers/promises": "workerd",
  tls: "workerd-and-loopback",
  tty: "kernel-terminal",
  url: "workerd",
  util: "workerd",
  "util/types": "workerd",
  v8: "stubbed-telemetry",
  vm: "generated-worker-or-interpreter",
  worker_threads: "main-thread-metadata-only",
  zlib: "workerd",
} as const;

export type NodeBuiltinName = keyof typeof NODE_BUILTIN_ROUTES;

export function canonicalNodeBuiltin(specifier: string): NodeBuiltinName | undefined {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return Object.hasOwn(NODE_BUILTIN_ROUTES, name) ? (name as NodeBuiltinName) : undefined;
}

const IMPORTS = Object.freeze([
  { module: "host_fs", name: "open_tmpfile", kind: "function" },
  { module: "host_fs", name: "set_open_direct", kind: "function" },
  { module: "host_fs", name: "set_open_mode", kind: "function" },
  { module: "host_net", name: "net_recv", kind: "function" },
  { module: "host_net", name: "net_send", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "args_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "args_sizes_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "clock_time_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "environ_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "environ_sizes_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_close", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_fdstat_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_prestat_dir_name", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_prestat_get", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_read", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "fd_write", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "path_open", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "proc_exit", kind: "function" },
  { module: "wasi_snapshot_preview1", name: "random_get", kind: "function" },
] as const);

const EXPORTS = Object.freeze([
  { name: "__main_void", kind: "function" },
  { name: "_start", kind: "function" },
  { name: "memory", kind: "memory" },
] as const);

/** AgentOS registry package jq@0.4.0, kept separate from coreutils 0.3.5. */
export const KERNEL_JQ_ARTIFACT = Object.freeze({
  version: "0.4.0",
  registryRoot: "https://releases.rivet.dev/agent-os/",
  registryManifestPath: "0.4.0/software/manifest.json",
  packagePath:
    "packages/jq/0b4a0f10b05e696fcb3bbab5cff7dfd06f9f4882a725dc74275b892796e6d13e.aospkg",
  packageFile: "jq-0.4.0.aospkg",
  packageUrl:
    "https://releases.rivet.dev/agent-os/0.4.0/software/packages/jq/0b4a0f10b05e696fcb3bbab5cff7dfd06f9f4882a725dc74275b892796e6d13e.aospkg",
  packageBytes: 716_972,
  packageSha256: "0b4a0f10b05e696fcb3bbab5cff7dfd06f9f4882a725dc74275b892796e6d13e",
  packageEntry: "bin/jq",
  preparedFile: "jq.wasm",
  bytes: 714_592,
  sha256: "ea7268d6ac5618536f6bfbc599a1cc2749b0b19451c83cac0be9ca424ae897b3",
  imports: IMPORTS,
  exports: EXPORTS,
});

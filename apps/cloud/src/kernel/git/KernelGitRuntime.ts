import type { KernelAsyncProgramContext } from "../KernelAsyncProgram.ts";
import type { KernelExitStatus } from "../KernelProcessTable.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import { runKernelExecution } from "../process/KernelExecution.ts";
import { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "../wasi/internal_wasi_options.ts";
import { KernelGitFilesystemImports } from "./KernelGitFilesystemImports.ts";
import { KernelGitProcessImports } from "./KernelGitProcessImports.ts";
import { createKernelGitWasiImports } from "./KernelGitWasiImports.ts";
import type { KernelGitCredentials } from "./KernelGitCredentials.ts";

const NIMBUS_IMPORTS = Object.freeze({
  nimbus_fs: ["fd_chmod", "fd_stat", "path_access", "path_chmod", "path_stat", "umask"],
  nimbus_proc: ["dup", "dup2", "ids", "kill", "pipe", "spawn", "start", "startup_cwd", "wait"],
  wasi_snapshot_preview1: [
    "args_get",
    "args_sizes_get",
    "clock_time_get",
    "environ_get",
    "environ_sizes_get",
    "fd_close",
    "fd_fdstat_get",
    "fd_fdstat_set_flags",
    "fd_filestat_set_size",
    "fd_pread",
    "fd_prestat_get",
    "fd_prestat_dir_name",
    "fd_read",
    "fd_readdir",
    "fd_renumber",
    "fd_seek",
    "fd_sync",
    "fd_tell",
    "fd_write",
    "path_create_directory",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_link",
    "path_open",
    "path_readlink",
    "path_remove_directory",
    "path_rename",
    "path_symlink",
    "path_unlink_file",
    "poll_oneoff",
    "proc_exit",
    "random_get",
    "sock_shutdown",
  ],
});

export async function runKernelGitProgram(
  module: WebAssembly.Module,
  credentials: KernelGitCredentials,
  context: KernelAsyncProgramContext,
): Promise<KernelExitStatus> {
  assertImportInventory(module);
  const lifecycle = new WasiLifecycle(
    validateOptions({
      version: "preview1",
      args: [...context.args],
      env: { ...context.env },
      returnOnExit: true,
    }),
    true,
    {
      table: context.filesystem.descriptors,
      ownership: "borrowed",
      creation: {
        createInode: context.filesystem.createInode.bind(context.filesystem),
        takeCreateMode: context.filesystem.takeNextCreateMode.bind(context.filesystem),
      },
    },
  );
  const memory = () => lifecycle.memory.memory;
  const filesystem = new KernelGitFilesystemImports({
    memory,
    filesystem: context.filesystem,
    credentials,
  });
  const processes = new KernelGitProcessImports({ memory, context, credentials });
  const imports = Object.create(null) as WebAssembly.Imports;
  for (const namespace of new Set(WebAssembly.Module.imports(module).map((item) => item.module))) {
    if (namespace === "wasi_snapshot_preview1") {
      imports[namespace] = createKernelGitWasiImports(lifecycle, context.filesystem);
    } else if (namespace === "nimbus_fs") {
      imports[namespace] = filesystem.imports;
    } else if (namespace === "nimbus_proc") {
      imports[namespace] = processes.getImportObject();
    }
  }

  let exitCode: number;
  try {
    const instance = new WebAssembly.Instance(module, imports);
    exitCode = await runKernelExecution(context.signal, () => lifecycle.startAsync(instance));
  } catch (error) {
    if (context.signal.aborted)
      throw new KernelProcessCancelledError("Git execution was cancelled");
    throw error;
  }
  return Object.freeze({ exitCode, signal: 0, coreDumped: false });
}

function assertImportInventory(module: WebAssembly.Module): void {
  const imports = WebAssembly.Module.imports(module);
  const actual = new Map<string, string[]>();
  for (const item of imports) {
    if (item.kind !== "function")
      throw new Error(`Git has unsupported ${item.kind} import ${item.module}.${item.name}`);
    const names = actual.get(item.module) ?? [];
    names.push(item.name);
    actual.set(item.module, names);
  }
  const expectedNamespaces = Object.keys(NIMBUS_IMPORTS).sort();
  if ([...actual.keys()].sort().join("\0") !== expectedNamespaces.join("\0")) {
    throw new Error("Git WASM imports do not match the pinned Nimbus ABI namespaces");
  }
  for (const [namespace, allowed] of Object.entries(NIMBUS_IMPORTS)) {
    const expected = [...allowed].sort();
    const found = [...(actual.get(namespace) ?? [])].sort();
    if (expected.join("\0") !== found.join("\0")) {
      throw new Error(`Git WASM imports do not match the pinned Nimbus ABI: ${namespace}`);
    }
  }
}

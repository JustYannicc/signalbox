import { AgentOsDescriptorHost } from "./AgentOsDescriptorHost.ts";
import { AgentOsFileSystemHost } from "./AgentOsFileSystemHost.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import {
  KERNEL_COREUTILS_SPARSE_POINTERS,
  prepareKernelCoreutilsSparseImport,
} from "./KernelCoreutilsSparseMemory.ts";
import { mapErrno } from "./wasi/internal_wasi_calls.ts";
import { asWasiMemory, WasiMemory } from "./wasi/internal_wasi_memory.ts";

const EBADF = 8;
const EFAULT = 21;
const EINVAL = 28;
const ENOSYS = 52;

const HOST_NET_CALLS = new Set([
  "net_socket",
  "net_connect",
  "net_send",
  "net_recv",
  "net_close",
  "net_getaddrinfo",
  "net_tls_connect",
  "net_setsockopt",
  "net_getsockname",
  "net_getpeername",
  "net_poll",
  "net_bind",
  "net_listen",
  "net_accept",
  "net_sendto",
  "net_recvfrom",
]);

const HOST_USER_CALLS = new Set([
  "getuid",
  "getgid",
  "geteuid",
  "getegid",
  "getresuid",
  "getresgid",
  "setuid",
  "seteuid",
  "setreuid",
  "setresuid",
  "setgid",
  "setegid",
  "setregid",
  "setresgid",
  "getgroups",
  "setgroups",
  "isatty",
  "getpwuid",
  "getpwnam",
  "getpwent",
  "getgrgid",
  "getgrnam",
  "getgrent",
]);

export interface KernelCoreutilsCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly effectiveUid: number;
  readonly effectiveGid: number;
}

export interface KernelCoreutilsImportOptions {
  readonly module?: WebAssembly.Module;
  readonly memory: () => WebAssembly.Memory | WasiMemory;
  readonly fileSystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  readonly asyncMode: boolean;
  readonly currentSignal?: () => AbortSignal | undefined;
  /** Identity syscalls stay ENOSYS unless the owner supplies its real credentials. */
  readonly credentials?: KernelCoreutilsCredentials;
}

/**
 * Build only the AgentOS namespaces imported by a pinned coreutils module.
 * WASI stays with WasiLifecycle; filesystem and descriptor calls keep using
 * the shared kernel descriptor table.
 */
export function createKernelCoreutilsImports(
  options: KernelCoreutilsImportOptions,
): WebAssembly.Imports {
  if (options.module === undefined) {
    return {
      host_fs: hostFileSystemImports(options),
      host_process: hostDescriptorImports(options),
      host_net: unsupportedImports(HOST_NET_CALLS, HOST_NET_CALLS, ENOSYS, "host_net"),
      host_user: hostUserImports(options, HOST_USER_CALLS),
    };
  }

  const requested = new Map<string, Set<string>>();
  for (const item of WebAssembly.Module.imports(options.module)) {
    if (item.kind !== "function") continue;
    const names = requested.get(item.module) ?? new Set<string>();
    names.add(item.name);
    requested.set(item.module, names);
  }

  const result = Object.create(null) as WebAssembly.Imports;
  for (const [namespace, names] of requested) {
    if (namespace === "wasi_snapshot_preview1" || namespace === "wasi_unstable") continue;
    if (namespace === "host_fs") {
      result[namespace] = hostFileSystemImports(options, names);
      continue;
    }
    if (namespace === "host_process") {
      result[namespace] = hostDescriptorImports(options, names);
      continue;
    }
    if (namespace === "host_net") {
      result[namespace] = unsupportedImports(names, HOST_NET_CALLS, ENOSYS, namespace);
      continue;
    }
    if (namespace === "host_user") {
      result[namespace] = hostUserImports(options, names);
      continue;
    }
    throw new Error(`Unsupported coreutils import namespace: ${namespace}`);
  }
  return result;
}

function hostFileSystemImports(
  options: KernelCoreutilsImportOptions,
  requested?: ReadonlySet<string>,
): Record<string, WebAssembly.ImportValue> {
  let scratch: WebAssembly.Memory | undefined;
  const host = new AgentOsFileSystemHost({
    memory: () => {
      if (scratch !== undefined) return scratch;
      const memory = options.memory();
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new Error("Coreutils filesystem import requires its sparse memory adapter");
      }
      return memory;
    },
    fileSystem: options.fileSystem,
    agentOsPreopens: true,
  });
  const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
  for (const name of requested ?? new Set(Object.keys(host.imports))) {
    const handler = host.imports[name as keyof typeof host.imports];
    if (handler !== undefined) {
      const pointers = KERNEL_COREUTILS_SPARSE_POINTERS.host_fs[name];
      if (pointers === undefined) {
        throw new Error(`No pinned sparse pointer map for coreutils import: host_fs.${name}`);
      }
      if (pointers.length > 0) {
        imports[name] = ((...args: (number | bigint)[]) => {
          const memory = options.memory();
          if (memory instanceof WebAssembly.Memory) {
            return Reflect.apply(handler, undefined, args);
          }
          const call = prepareKernelCoreutilsSparseImport(memory, args, pointers);
          scratch = call.memory;
          try {
            const result = Reflect.apply(handler, undefined, call.args);
            if (result === 0) call.copyOutputs(memory);
            return result;
          } finally {
            scratch = undefined;
          }
        }) as WebAssembly.ImportValue;
        continue;
      }
      imports[name] = handler as WebAssembly.ImportValue;
      continue;
    }
    throw new Error(`No pinned host_fs ABI mapping for coreutils import: ${name}`);
  }
  return imports;
}

function hostDescriptorImports(
  options: KernelCoreutilsImportOptions,
  requested?: ReadonlySet<string>,
): Record<string, WebAssembly.ImportValue> {
  const host = new AgentOsDescriptorHost({
    memory: options.memory,
    descriptors: options.fileSystem.descriptors,
    wakes: options.wakes,
    asyncMode: options.asyncMode,
    ...(options.currentSignal === undefined ? {} : { currentSignal: options.currentSignal }),
  });
  const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
  const allNames = new Set([...Object.keys(host.imports), "proc_umask"]);
  for (const name of requested ?? allNames) {
    if (name === "proc_umask") {
      imports[name] = (mask: number, previousPointer: number) => {
        const next = mask >>> 0;
        if ((next & ~0o777) !== 0) return EINVAL;
        try {
          const memory = asWasiMemory(options.memory());
          const previous = memory.view(previousPointer, 4);
          const oldMask = options.fileSystem.setUmask(next);
          previous.setUint32(0, oldMask, true);
          return 0;
        } catch (error) {
          try {
            return mapErrno(error);
          } catch {
            return EFAULT;
          }
        }
      };
      continue;
    }

    const handler = host.imports[name as keyof typeof host.imports];
    if (handler === undefined) {
      throw new Error(`No pinned host_process ABI mapping for coreutils import: ${name}`);
    }
    imports[name] = handler as WebAssembly.ImportValue;
  }
  return imports;
}

function hostUserImports(
  options: KernelCoreutilsImportOptions,
  requested: ReadonlySet<string>,
): Record<string, WebAssembly.ImportValue> {
  const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
  for (const name of requested) {
    if (!HOST_USER_CALLS.has(name)) {
      throw new Error(`No pinned host_user ABI mapping for coreutils import: ${name}`);
    }
    if (name === "isatty") {
      imports[name] = (fd: number, resultPointer: number) => {
        const memory = asWasiMemory(options.memory());
        try {
          options.fileSystem.descriptors.get(fd >>> 0);
          memory.u32(resultPointer, 0);
          return 0;
        } catch (error) {
          return errno(error);
        }
      };
      continue;
    }
    const identityField = identityFieldFor(name);
    if (identityField !== undefined) {
      const value = options.credentials?.[identityField];
      imports[name] = (resultPointer: number) => {
        if (value === undefined) return ENOSYS;
        try {
          const memory = asWasiMemory(options.memory());
          memory.u32(resultPointer, value);
          return 0;
        } catch {
          return EFAULT;
        }
      };
      continue;
    }
    imports[name] = (..._args: number[]) => ENOSYS;
  }
  return imports;
}

function unsupportedImports(
  requested: ReadonlySet<string>,
  known: ReadonlySet<string>,
  errnoCode: number,
  namespace: string,
): Record<string, WebAssembly.ImportValue> {
  const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
  for (const name of requested) {
    if (!known.has(name)) throw new Error(`No pinned ${namespace} ABI mapping for import: ${name}`);
    imports[name] = (..._args: number[]) => errnoCode;
  }
  return imports;
}

function identityFieldFor(name: string): keyof KernelCoreutilsCredentials | undefined {
  switch (name) {
    case "getuid":
      return "uid";
    case "getgid":
      return "gid";
    case "geteuid":
      return "effectiveUid";
    case "getegid":
      return "effectiveGid";
    default:
      return undefined;
  }
}

function errno(error: unknown): number {
  if (typeof error !== "object" || error === null || !("errno" in error)) return EBADF;
  const value = (error as { readonly errno?: unknown }).errno;
  return typeof value === "number" && Number.isInteger(value) ? value : EBADF;
}

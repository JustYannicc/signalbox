import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { createKernelNimbusMetadata } from "../KernelNimbusMetadata.ts";
import { errno, range } from "../bash/BashMemory.ts";
import type { WasiMemory } from "../wasi/internal_wasi_memory.ts";

const ENOSPC = 68;
export const KERNEL_BUSYBOX_IMPORT_NAMES = Object.freeze([
  "identity",
  "chown",
  "stat_metadata",
  "chmod",
  "fchmod",
  "startup_cwd",
  "account",
] as const);
const NIMBUS_IMPORTS = new Set<string>(KERNEL_BUSYBOX_IMPORT_NAMES);

export interface KernelBusyboxImportOptions {
  readonly module: WebAssembly.Module;
  readonly memory: () => WebAssembly.Memory | WasiMemory;
  readonly filesystem: KernelFileSystem;
  readonly pid: number;
  readonly parentPid: number;
}

/** Nimbus BusyBox has no async process imports; its VFS calls stay with WASI. */
export function createKernelBusyboxImports(
  options: KernelBusyboxImportOptions,
): WebAssembly.Imports {
  const requested = new Set<string>();
  for (const item of WebAssembly.Module.imports(options.module)) {
    if (item.module === "wasi_snapshot_preview1") continue;
    if (
      item.module !== "nimbus_proc" ||
      item.kind !== "function" ||
      !NIMBUS_IMPORTS.has(item.name)
    ) {
      throw new Error(`Unsupported BusyBox import: ${item.module}.${item.name}`);
    }
    requested.add(item.name);
  }

  return Object.freeze({
    nimbus_proc: createKernelBusyboxNamedImports({ ...options, names: [...requested] }),
  });
}

/** The facet supplies validated import names without compiling or owning the guest module. */
export function createKernelBusyboxNamedImports(
  options: Omit<KernelBusyboxImportOptions, "module"> & { readonly names: readonly string[] },
): Readonly<Record<string, (...args: number[]) => number>> {
  for (const name of options.names) {
    if (!NIMBUS_IMPORTS.has(name))
      throw new Error(`Unsupported BusyBox import: nimbus_proc.${name}`);
  }
  const credentials = options.filesystem.posixCredentials;
  if (credentials === undefined) {
    throw Object.assign(new Error("BusyBox requires an explicit POSIX filesystem policy"), {
      code: "ENOTSUP",
    });
  }
  if (credentials.uid !== credentials.euid || credentials.gid !== credentials.egid) {
    throw Object.assign(new Error("Pinned BusyBox cannot represent differing effective ids"), {
      code: "ENOTSUP",
    });
  }

  const metadata = createKernelNimbusMetadata({
    memory: options.memory,
    filesystem: options.filesystem,
  });
  const imports = Object.create(null) as Record<string, (...args: number[]) => number>;
  for (const name of options.names) {
    switch (name) {
      case "identity":
        imports[name] = (field: number) => {
          if (field === 0) return credentials.uid;
          if (field === 1) return credentials.gid;
          if (field === 2) return options.pid;
          if (field === 3) return options.parentPid;
          const encodedMask = field - 4;
          if (encodedMask < 0 || encodedMask % 8 !== 0 || encodedMask / 8 > 0o777) {
            throw new Error(`Unsupported BusyBox identity field: ${field}`);
          }
          return options.filesystem.setUmask(encodedMask / 8);
        };
        break;
      case "startup_cwd":
        imports[name] = (pointer: number, capacity: number) => {
          try {
            const bytes = new TextEncoder().encode(options.filesystem.cwd);
            if (capacity === 0) return bytes.byteLength;
            if (capacity >>> 0 <= bytes.byteLength) return -ENOSPC;
            const target = range(options.memory(), pointer, bytes.byteLength + 1);
            target.set(bytes);
            target[bytes.byteLength] = 0;
            return bytes.byteLength;
          } catch (error) {
            return -errno(error);
          }
        };
        break;
      case "stat_metadata":
        imports[name] = metadata.stat_metadata;
        break;
      case "account":
        // Nimbus uses the same nimbus-libc account record ABI in Bash and BusyBox.
        imports[name] = metadata.account;
        break;
      case "chown":
        imports[name] = metadata.chown;
        break;
      case "chmod":
        imports[name] = metadata.chmod;
        break;
      case "fchmod":
        imports[name] = metadata.fchmod;
        break;
    }
  }
  return Object.freeze(imports);
}

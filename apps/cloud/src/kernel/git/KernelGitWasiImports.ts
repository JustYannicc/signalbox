import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelOpenFlags } from "../KernelFileSystem.ts";
import { mapErrno, runAsync, type WasiCall } from "../wasi/internal_wasi_calls.ts";
import { ALL_RIGHTS, RIGHTS, type WasiDescriptor } from "../wasi/internal_wasi_descriptors.ts";
import type { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";

const ENOTCAPABLE = 76;
const OFLAGS = { CREATE: 1, DIRECTORY: 2, EXCLUSIVE: 4, TRUNCATE: 8 } as const;
const FD_FLAGS = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const;

type WasmArgument = number | bigint;
type RawPathOpen = (...args: WasmArgument[]) => WasiCall<number>;

/** Keeps WASI path_open on the normal table, with virtual /dev devices from KernelFileSystem. */
export function createKernelGitWasiImports(
  lifecycle: WasiLifecycle,
  filesystem: KernelFileSystem,
): WebAssembly.ModuleImports {
  const imports = Object.assign(Object.create(null), lifecycle.wasiImport) as Record<
    string,
    WebAssembly.ImportValue
  >;
  const wasm = WebAssembly as unknown as {
    Suspending?: new (fn: (...args: WasmArgument[]) => Promise<number>) => WebAssembly.ImportValue;
  };
  if (typeof wasm.Suspending !== "function") {
    throw Object.assign(new Error("Git's shared WASI imports require WebAssembly JSPI"), {
      code: "ERR_KERNEL_JSPI_UNAVAILABLE",
    });
  }
  const rawPathOpen = lifecycle.filesystem.imports.path_open as RawPathOpen;
  imports.path_open = new wasm.Suspending(async (...args) => {
    try {
      const device = virtualDevicePath(lifecycle, filesystem, args);
      if (device !== undefined) return openVirtualDevice(lifecycle, filesystem, device, args);
      const fdflags = numericArgument(args[7]);
      if (fdflags === undefined) return 28;
      // POSIX ignores O_NONBLOCK for regular files and directories; WASI's
      // generic host rejects it because kernel descriptors cannot honor it.
      const compatibleArgs = [...args];
      compatibleArgs[7] = fdflags & ~FD_FLAGS.NONBLOCK;
      return await runAsync(rawPathOpen(...compatibleArgs));
    } catch (error) {
      return mapErrno(error);
    }
  });
  return imports;
}

function virtualDevicePath(
  lifecycle: WasiLifecycle,
  filesystem: KernelFileSystem,
  args: readonly WasmArgument[],
): "null" | "zero" | "random" | undefined {
  const directoryFd = args[0];
  const pathPointer = args[2];
  const pathLength = args[3];
  if (
    typeof directoryFd !== "number" ||
    typeof pathPointer !== "number" ||
    typeof pathLength !== "number"
  ) {
    return undefined;
  }
  let directory: WasiDescriptor;
  try {
    directory = filesystem.descriptors.get(directoryFd >>> 0);
  } catch {
    return undefined;
  }
  if (
    directory.kind !== "directory" ||
    directory.preopenPath !== "/" ||
    (directory.pathComponents?.length ?? 0) !== 0
  ) {
    return undefined;
  }
  const path = lifecycle.memory.string(pathPointer, pathLength);
  switch (path.replace(/^\.\//, "")) {
    case "dev/null":
      return "null";
    case "dev/zero":
      return "zero";
    case "dev/random":
      return "random";
    default:
      return undefined;
  }
}

function openVirtualDevice(
  lifecycle: WasiLifecycle,
  filesystem: KernelFileSystem,
  device: "null" | "zero" | "random",
  args: readonly WasmArgument[],
): number {
  const oflags = numericArgument(args[4]);
  const rightsBase = bigintArgument(args[5]);
  const rightsInheriting = bigintArgument(args[6]);
  const fdflags = numericArgument(args[7]);
  const outputPointer = numericArgument(args[8]);
  if (
    oflags === undefined ||
    rightsBase === undefined ||
    rightsInheriting === undefined ||
    fdflags === undefined ||
    outputPointer === undefined
  ) {
    return 28;
  }
  try {
    lifecycle.memory.range(outputPointer, 4);
    if ((oflags & ~(OFLAGS.CREATE | OFLAGS.DIRECTORY | OFLAGS.EXCLUSIVE | OFLAGS.TRUNCATE)) !== 0)
      return 28;
    if (
      (fdflags &
        ~(
          FD_FLAGS.APPEND |
          FD_FLAGS.DSYNC |
          FD_FLAGS.NONBLOCK |
          FD_FLAGS.RSYNC |
          FD_FLAGS.SYNC
        )) !==
      0
    )
      return 28;
    const directory = filesystem.descriptors.get(numericArgument(args[0])! >>> 0);
    if (
      ((rightsBase | rightsInheriting) & ~ALL_RIGHTS) !== 0n ||
      ((rightsBase | rightsInheriting) & ~directory.rightsInheriting) !== 0n
    ) {
      return ENOTCAPABLE;
    }
    let flags = openAccessMode(rightsBase);
    if ((oflags & OFLAGS.CREATE) !== 0) flags |= KernelOpenFlags.O_CREAT;
    if ((oflags & OFLAGS.DIRECTORY) !== 0) flags |= KernelOpenFlags.O_DIRECTORY;
    if ((oflags & OFLAGS.EXCLUSIVE) !== 0) flags |= KernelOpenFlags.O_EXCL;
    if ((oflags & OFLAGS.TRUNCATE) !== 0) flags |= KernelOpenFlags.O_TRUNC;
    if ((fdflags & FD_FLAGS.APPEND) !== 0) flags |= KernelOpenFlags.O_APPEND;
    if ((fdflags & FD_FLAGS.DSYNC) !== 0) flags |= KernelOpenFlags.O_DSYNC;
    if ((fdflags & FD_FLAGS.SYNC) !== 0) flags |= KernelOpenFlags.O_SYNC;
    const fd = filesystem.open(`/dev/${device}`, flags);
    const descriptor = filesystem.descriptors.get(fd);
    descriptor.rightsBase = rightsBase;
    descriptor.rightsInheriting = rightsInheriting;
    descriptor.flags = fdflags;
    lifecycle.memory.u32(outputPointer, fd);
    return 0;
  } catch (error) {
    return mapErrno(error);
  }
}

function openAccessMode(rights: bigint): number {
  const readable = (rights & RIGHTS.FD_READ) !== 0n;
  const writable = (rights & RIGHTS.FD_WRITE) !== 0n;
  return readable && writable
    ? KernelOpenFlags.O_RDWR
    : writable
      ? KernelOpenFlags.O_WRONLY
      : KernelOpenFlags.O_RDONLY;
}

function numericArgument(value: WasmArgument | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function bigintArgument(value: WasmArgument | undefined): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

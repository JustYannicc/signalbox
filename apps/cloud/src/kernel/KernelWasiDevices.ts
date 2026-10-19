import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import {
  deviceInfoForDescriptor,
  deviceStat,
  virtualDevice,
  type DeviceInfo,
} from "./filesystem/KernelVirtualDevices.ts";
import { joinGuestPath } from "./filesystem/KernelPathResolver.ts";
import { complete, type WasiCall } from "./wasi/internal_wasi_calls.ts";
import { FDFLAGS, RIGHTS } from "./wasi/internal_wasi_descriptors.ts";
import { writeFilestat } from "./wasi/internal_wasi_fd_calls.ts";
import type { WasiFileSystemImportAdapter } from "./wasi/internal_wasi_lifecycle.ts";
import { WasiError, type WasiMemory } from "./wasi/internal_wasi_memory.ts";
import { WasiPathCalls } from "./wasi/internal_wasi_path_calls.ts";
import { WasiPathResolver, type WasiMountedStorage } from "./wasi/internal_wasi_paths.ts";

class DevicePath extends Error {
  readonly path: string;
  readonly info: DeviceInfo;
  readonly mount: WasiMountedStorage;

  constructor(path: string, info: DeviceInfo, mount: WasiMountedStorage) {
    super("Canonical virtual device");
    this.path = path;
    this.info = info;
    this.mount = mount;
  }
}

/** Reuses preview1 validation and traversal, then opens devices on the owner's table. */
export function createKernelWasiDeviceAdapter(
  filesystem: KernelFileSystem,
): WasiFileSystemImportAdapter {
  return (memory, imports) => {
    const paths = new WasiPathResolver(
      complete,
      filesystem.assertWasiPathVisible.bind(filesystem),
      (parent, name, remaining, requireDirectory) => {
        const missing = joinGuestPath(parent.mount.path, [...parent.pathComponents, name]);
        // Only an absent /dev directory may supply the virtual namespace itself.
        // Existing directories, symlinks and shadowing files have already won the lookup.
        const tail = remaining.filter((component) => component !== "");
        const namespace = missing === "/dev";
        const path = namespace && tail.length > 0 ? `${missing}/${tail[0]}` : missing;
        const info = virtualDevice(path);
        if (info === undefined) return;
        filesystem.assertWasiPathVisible(parent.mount, [
          ...parent.pathComponents,
          name,
          ...tail.slice(0, namespace ? 1 : 0),
        ]);
        if (requireDirectory || tail.length > (namespace ? 1 : 0)) throw new WasiError(54);
        throw new DevicePath(path, info, parent.mount);
      },
    );
    const calls = new WasiPathCalls(
      memory,
      filesystem.descriptors,
      paths,
      {
        createInode: filesystem.createInode.bind(filesystem),
        takeCreateMode: filesystem.takeNextCreateMode.bind(filesystem),
      },
      () => filesystem.fileBytes,
    );
    return {
      ...imports,
      path_open: function* (...args): WasiCall<number> {
        try {
          return yield* calls.imports.path_open(...args);
        } catch (error) {
          if (!(error instanceof DevicePath)) throw error;
          const [, , , , oflags, rightsBase, , fdflags, output] = args;
          if ((oflags & 8) !== 0 && error.mount.readOnly) throw new WasiError(69);
          const fd = filesystem.open(error.path, kernelOpenFlags(oflags, rightsBase, fdflags));
          try {
            const descriptor = filesystem.descriptors.get(fd);
            descriptor.rightsBase &= BigInt.asUintN(64, rightsBase);
            descriptor.rightsInheriting = 0n;
            descriptor.flags = fdflags;
            memory.u32(output, fd);
            return 0;
          } catch (failure) {
            filesystem.close(fd);
            throw failure;
          }
        }
      },
      path_filestat_get: function* (...args): WasiCall<number> {
        try {
          return yield* calls.imports.path_filestat_get(...args);
        } catch (error) {
          if (!(error instanceof DevicePath)) throw error;
          writeDeviceStat(memory, args[4], error.info);
          return 0;
        }
      },
      fd_filestat_get: function* (fd, output): WasiCall<number> {
        const result = yield* imports.fd_filestat_get(fd, output);
        const info = deviceInfoForDescriptor(filesystem.descriptors.get(fd));
        if (info !== undefined) writeDeviceStat(memory, output, info);
        return result;
      },
    };
  };
}

function writeDeviceStat(memory: WasiMemory, output: number, info: DeviceInfo): void {
  const stat = deviceStat(info);
  writeFilestat(memory, output, stat.dev, stat.ino, { ...stat, type: "file" }, "character");
}

// Input flags have already passed WasiPathCalls validation; this only translates the ABI.
function kernelOpenFlags(oflags: number, rights: bigint, fdflags: number): number {
  let flags =
    (rights & RIGHTS.FD_WRITE) === 0n
      ? KernelOpenFlags.O_RDONLY
      : (rights & RIGHTS.FD_READ) === 0n
        ? KernelOpenFlags.O_WRONLY
        : KernelOpenFlags.O_RDWR;
  if ((oflags & 1) !== 0) flags |= KernelOpenFlags.O_CREAT;
  if ((oflags & 2) !== 0) flags |= KernelOpenFlags.O_DIRECTORY;
  if ((oflags & 4) !== 0) flags |= KernelOpenFlags.O_EXCL;
  if ((oflags & 8) !== 0) flags |= KernelOpenFlags.O_TRUNC;
  if ((fdflags & FDFLAGS.APPEND) !== 0) flags |= KernelOpenFlags.O_APPEND;
  if ((fdflags & FDFLAGS.NONBLOCK) !== 0) flags |= KernelOpenFlags.O_NONBLOCK;
  if ((fdflags & FDFLAGS.DSYNC) !== 0) flags |= KernelOpenFlags.O_DSYNC;
  if ((fdflags & (FDFLAGS.RSYNC | FDFLAGS.SYNC)) !== 0) flags |= KernelOpenFlags.O_SYNC;
  return flags;
}

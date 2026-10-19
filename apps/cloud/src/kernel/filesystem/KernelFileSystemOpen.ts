import {
  canonicalFileByteSelection,
  bindFileByteAccess,
  type KernelFileByteAccess,
  type KernelFileByteSelection,
} from "../KernelFileBytes.ts";
import { WasiDescriptorTable, type WasiDescriptor } from "../wasi/internal_wasi_descriptors.ts";
import type { Stat } from "../storage.ts";
import { FDFLAGS, RIGHTS } from "../wasi/internal_wasi_descriptors.ts";
import type { WasiResolvedPath } from "../wasi/internal_wasi_paths.ts";
import { descriptorPathAlias } from "./KernelPathAliases.ts";
import { kernelError, runKernelSync, withKernelErrors } from "./KernelFileSystemErrors.ts";
import {
  descriptorRights,
  KernelOpenFlags,
  parseOpenFlags,
  type ParsedOpenFlags,
} from "./KernelOpenFlags.ts";
import { KernelFileSystemPaths } from "./KernelFileSystemPaths.ts";
import {
  deviceInfoForDescriptor,
  virtualDevice,
  virtualDeviceStdio,
} from "./KernelVirtualDevices.ts";

export class KernelFileSystemOpen {
  readonly #descriptors: WasiDescriptorTable;
  readonly #paths: KernelFileSystemPaths;
  readonly #fileBytes: () => KernelFileByteSelection;

  constructor(
    descriptors: WasiDescriptorTable,
    paths: KernelFileSystemPaths,
    fileBytes: () => KernelFileByteSelection = () => canonicalFileByteSelection,
  ) {
    this.#descriptors = descriptors;
    this.#paths = paths;
    this.#fileBytes = fileBytes;
  }

  open(path: string, flags: number, mode = 0o666): number {
    return withKernelErrors(() => {
      const parsed = parseOpenFlags(flags);
      const device = virtualDevice(path);
      if (device !== undefined) return this.#openDevice(device.name, parsed);
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) return this.#openAlias(alias, parsed);

      const followFinal = !parsed.noFollow && !(parsed.create && parsed.exclusive);
      const lookup = this.#paths.resolveOrCreate(path, { followFinal });
      if (lookup.kind === "missing") {
        if (!parsed.create) throw kernelError("ENOENT");
        if (parsed.directory) throw kernelError("EINVAL");
        if (lookup.parent.mount.readOnly) throw kernelError("EROFS");
        const inode = this.#paths.createInode(
          lookup.parent.mount,
          lookup.parent.parent,
          lookup.parent.name,
          {
            type: "file",
            exclusive: true,
          },
          mode,
        );
        let stat: Stat;
        try {
          stat = runKernelSync(lookup.parent.mount.storage.stat(inode));
        } catch (error) {
          runKernelSync(lookup.parent.mount.storage.release(inode));
          throw error;
        }
        return this.#openResolved(
          {
            mount: lookup.parent.mount,
            inode,
            stat,
            parent: lookup.parent.parent,
            name: lookup.parent.name,
            pathComponents: lookup.parent.pathComponents,
            ancestors: lookup.parent.ancestors,
          },
          parsed,
          true,
        );
      }

      if (parsed.create && parsed.exclusive) throw kernelError("EEXIST");
      return this.#openResolved(lookup.path, parsed, false);
    });
  }

  close(fd: number): void {
    withKernelErrors(() => this.#paths.resolver.run(this.#descriptors.close(fd)));
  }

  #openDevice(name: "null" | "zero" | "random", parsed: ParsedOpenFlags): number {
    if ((parsed.statusFlags & FDFLAGS.NONBLOCK) !== 0) {
      throw kernelError("ENOTSUP", "Nonblocking stream and device opens are unsupported");
    }
    if (parsed.directory) throw kernelError("ENOTDIR");
    if (parsed.create && parsed.exclusive) throw kernelError("EEXIST");
    const stdio = virtualDeviceStdio(name);
    const rightsBase = parsed.pathOnly ? RIGHTS.FD_FILESTAT_GET : parsed.rightsBase;
    return this.#descriptors.allocate({
      kind: "stdio",
      stdio,
      offset: 0n,
      rightsBase,
      rightsInheriting: 0n,
      flags: parsed.pathOnly ? 0 : parsed.statusFlags,
      closeOnExec: parsed.closeOnExec,
    });
  }

  #openAlias(fd: number, parsed: ParsedOpenFlags): number {
    if (parsed.create && parsed.exclusive) throw kernelError("EEXIST");
    const source = this.#getAlias(fd);
    if (parsed.noFollow && !parsed.pathOnly) throw kernelError("ELOOP");
    if (parsed.noFollow && parsed.pathOnly) {
      throw kernelError("ENOTSUP", "Opening a proc magic link itself is unsupported");
    }
    if (source.kind === "stdio") {
      const device = deviceInfoForDescriptor(source);
      return device === undefined
        ? this.#duplicateStream(source, parsed)
        : this.#openDevice(device.name, parsed);
    }
    const resolved = this.#resolvedAliasTarget(source, parsed);
    return this.#openResolved(
      resolved,
      parsed,
      false,
      source.byteView === undefined
        ? { kind: "canonical" }
        : { kind: "view", view: source.byteView },
    );
  }

  #duplicateStream(source: WasiDescriptor, parsed: ParsedOpenFlags): number {
    if ((parsed.statusFlags & FDFLAGS.NONBLOCK) !== 0) {
      throw kernelError("ENOTSUP", "Nonblocking stream and device opens are unsupported");
    }
    if (parsed.pathOnly && parsed.noFollow) {
      throw kernelError("ENOTSUP", "Opening a proc magic link itself is unsupported");
    }
    const required =
      (parsed.accessMode !== KernelOpenFlags.O_WRONLY ? RIGHTS.FD_READ : 0n) |
      (parsed.accessMode !== KernelOpenFlags.O_RDONLY ? RIGHTS.FD_WRITE : 0n);
    if ((source.rightsBase & required) !== required) throw kernelError("EBADF");
    const rightsBase = parsed.pathOnly ? RIGHTS.FD_FILESTAT_GET : source.rightsBase;
    if ((source.rightsBase & rightsBase) !== rightsBase) throw kernelError("EBADF");
    return this.#descriptors.duplicate(source.fd, {
      rightsBase,
      rightsInheriting: 0n,
      closeOnExec: parsed.closeOnExec,
    });
  }

  #resolvedAliasTarget(source: WasiDescriptor, parsed: ParsedOpenFlags): WasiResolvedPath {
    if (source.mount === undefined || source.inode === undefined) throw kernelError("EBADF");
    if (source.kind !== "symlink" || (parsed.pathOnly && parsed.noFollow)) {
      return this.#paths.resolver.resolvedDescriptor(source);
    }
    const target = runKernelSync(source.mount.storage.readlink(source.inode));
    if (parsed.noFollow) throw kernelError("ELOOP");
    if (target.startsWith("/")) return this.#paths.resolve(target);
    const anchor = this.#paths.resolver.anchorForDescriptorParent(source);
    return this.#paths.resolver.resolveFromAnchor(anchor, target, true);
  }

  #openResolved(
    resolved: WasiResolvedPath,
    parsed: ParsedOpenFlags,
    retained: boolean,
    selection: KernelFileByteSelection = this.#fileBytes(),
  ): number {
    const mount = resolved.mount;
    const inode = resolved.inode;
    let ownsPin = retained;
    let byteAccess: KernelFileByteAccess | undefined;
    try {
      if (!ownsPin) {
        runKernelSync(mount.storage.retain(inode));
        ownsPin = true;
      }
      if (
        resolved.stat.type === "directory" &&
        !parsed.pathOnly &&
        parsed.accessMode !== KernelOpenFlags.O_RDONLY
      ) {
        throw kernelError("EISDIR");
      }
      if (
        !parsed.pathOnly &&
        (parsed.accessMode !== KernelOpenFlags.O_RDONLY || parsed.truncate) &&
        mount.readOnly
      ) {
        throw kernelError("EROFS");
      }
      if (parsed.directory && resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
      if (resolved.stat.type === "symlink" && !(parsed.pathOnly && parsed.noFollow)) {
        throw kernelError("ELOOP");
      }
      if (parsed.truncate && resolved.stat.type !== "file") {
        throw kernelError(resolved.stat.type === "directory" ? "EISDIR" : "EINVAL");
      }
      if (resolved.stat.type === "file") {
        byteAccess = bindFileByteAccess(selection, mount.storage, inode);
      }
      if (parsed.truncate) {
        if (byteAccess) byteAccess.truncate(0n);
        else runKernelSync(mount.storage.truncate(inode, 0n));
      }
      const rights = descriptorRights(parsed, resolved.stat.type, mount.readOnly);
      const fd = this.#descriptors.allocate({
        kind: resolved.stat.type,
        mount,
        inode,
        capabilityRoot: resolved.ancestors[0] ?? mount.root,
        ancestors: [...resolved.ancestors],
        pathComponents: [...resolved.pathComponents],
        offset: 0n,
        rightsBase: rights.base,
        rightsInheriting: rights.inheriting,
        flags: parsed.pathOnly ? 0 : parsed.statusFlags,
        closeOnExec: parsed.closeOnExec,
        ...(byteAccess === undefined
          ? {}
          : {
              byteAccess,
              byteView: selection.kind === "view" ? selection.view : undefined,
            }),
      });
      byteAccess = undefined;
      ownsPin = false;
      return fd;
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        byteAccess?.release();
      } catch (failure) {
        failures.push(failure);
      }
      if (ownsPin) {
        try {
          runKernelSync(mount.storage.release(inode));
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "File open and cleanup failed", { cause: error });
      throw error;
    }
  }

  #getAlias(fd: number): WasiDescriptor {
    try {
      return withKernelErrors(() => this.#descriptors.get(fd));
    } catch (error) {
      if (isCode(error, "EBADF")) throw kernelError("ENOENT");
      throw error;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

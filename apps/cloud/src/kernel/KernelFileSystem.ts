import type { Mount, Storage, Times } from "./storage.ts";
import { WasiFileSystem } from "./wasi/internal_wasi_fs.ts";
import { WasiMemory } from "./wasi/internal_wasi_memory.ts";
import { runSync } from "./wasi/internal_wasi_calls.ts";
import { WasiDescriptorTable, type WasiStdio } from "./wasi/internal_wasi_descriptors.ts";
import type {
  WasiMountedStorage,
  WasiPathAnchor,
  WasiResolvedPath,
} from "./wasi/internal_wasi_paths.ts";
import { KernelFileSystemIo } from "./filesystem/KernelFileSystemIo.ts";
import { KernelFileSystemOpen } from "./filesystem/KernelFileSystemOpen.ts";
import { KernelFileSystemPaths } from "./filesystem/KernelFileSystemPaths.ts";
import {
  joinGuestPath,
  KernelPathResolver,
  mountedStorageForTable,
} from "./filesystem/KernelPathResolver.ts";
import {
  kernelError,
  runKernelSync,
  withKernelErrors,
} from "./filesystem/KernelFileSystemErrors.ts";
import { KernelOpenFlags } from "./filesystem/KernelOpenFlags.ts";
import type { KernelStat } from "./filesystem/KernelFileSystemTypes.ts";

export { KernelOpenFlags };
export type { KernelStat };
export type { WasiStdio } from "./wasi/internal_wasi_descriptors.ts";

export interface KernelFileSystemConfig {
  readonly mounts: Mount<Storage>[];
  readonly stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
  readonly cwd?: string;
  readonly descriptors?: WasiDescriptorTable;
}

const forkContextSymbol: unique symbol = Symbol("KernelFileSystem.forkContext");

interface KernelFileSystemForkContext {
  readonly mounts: readonly WasiMountedStorage[];
  readonly cwdAnchor?: WasiPathAnchor;
}

type KernelFileSystemInternalConfig = KernelFileSystemConfig & {
  readonly [forkContextSymbol]?: KernelFileSystemForkContext;
};

/** Synchronous Node-shaped view over the WASI inode and descriptor state. */
export class KernelFileSystem {
  readonly descriptors: WasiDescriptorTable;
  readonly #wasi: WasiFileSystem;
  readonly #paths: KernelFileSystemPaths;
  readonly #open: KernelFileSystemOpen;
  readonly #io: KernelFileSystemIo;
  readonly #mounts: Mount<Storage>[];
  readonly #mountedMounts: readonly WasiMountedStorage[];
  readonly #ownsDescriptors: boolean;
  #cwdAnchor: WasiPathAnchor | undefined;
  #disposed = false;

  constructor(config: KernelFileSystemConfig) {
    const forkContext = (config as KernelFileSystemInternalConfig)[forkContextSymbol];
    this.#mounts = config.mounts.map((mount) => ({ ...mount }));
    this.#ownsDescriptors = config.descriptors === undefined;
    this.#wasi = new WasiFileSystem(
      new WasiMemory(),
      this.#mounts,
      config.stdio === undefined ? [] : [...config.stdio],
      config.descriptors === undefined
        ? undefined
        : { table: config.descriptors, ownership: "borrowed" },
    );
    this.descriptors = this.#wasi.descriptors;

    try {
      if (this.#ownsDescriptors) withKernelErrors(() => runSync(this.#wasi.initialize()));
      this.#mountedMounts =
        forkContext?.mounts ?? mountedStorageForTable(this.#mounts, this.descriptors);
      const resolver = new KernelPathResolver(
        [...this.#mountedMounts],
        this.descriptors,
        forkContext?.cwdAnchor,
      );
      this.#paths = new KernelFileSystemPaths(resolver, this.descriptors);
      this.#open = new KernelFileSystemOpen(this.descriptors, this.#paths);
      this.#io = new KernelFileSystemIo(this.descriptors);
      if (forkContext?.cwdAnchor !== undefined) {
        this.#retainCwdAnchor(forkContext.cwdAnchor);
      } else {
        const cwd = config.cwd ?? this.#mounts[0]?.path;
        if (cwd !== undefined) this.#paths.chdir(cwd);
        const cwdAnchor = this.#paths.resolver.cwdAnchor;
        if (cwdAnchor !== undefined) this.#retainCwdAnchor(cwdAnchor);
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const cwdAnchor = this.#cwdAnchor;
      this.#cwdAnchor = undefined;
      if (cwdAnchor !== undefined) {
        try {
          runKernelSync(cwdAnchor.mount.storage.release(cwdAnchor.inode));
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (this.#ownsDescriptors) {
        try {
          withKernelErrors(() => runSync(this.#wasi.close()));
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Kernel filesystem setup and cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  get cwd(): string {
    this.#assertOpen();
    const anchor = this.#paths.resolver.validatedCwdAnchor();
    if (anchor === undefined) return this.#paths.cwd;
    this.#cwdAnchor = copyAnchor(anchor);
    return joinGuestPath(anchor.mount.path, anchor.pathComponents);
  }

  fork(descriptors: WasiDescriptorTable): KernelFileSystem {
    this.#assertOpen();
    const cwdAnchor = this.#cwdAnchor;
    const config: KernelFileSystemInternalConfig = {
      mounts: this.#mounts,
      descriptors,
      [forkContextSymbol]: {
        mounts: this.#mountedMounts,
        ...(cwdAnchor === undefined ? {} : { cwdAnchor: copyAnchor(cwdAnchor) }),
      },
    };
    return new KernelFileSystem(config);
  }

  resolve(path: string, options: { followFinal?: boolean; cwd?: string } = {}): WasiResolvedPath {
    this.#assertOpen();
    return this.#paths.resolve(path, options);
  }

  open(path: string, flags: number, mode?: number): number {
    this.#assertOpen();
    return this.#open.open(path, flags, mode);
  }

  close(fd: number): void {
    this.#assertOpen();
    this.#open.close(fd);
  }

  read(fd: number, target: Uint8Array, position: bigint | null): number {
    this.#assertOpen();
    return this.#io.read(fd, target, position);
  }

  write(fd: number, source: Uint8Array, position: bigint | null): number {
    this.#assertOpen();
    return this.#io.write(fd, source, position);
  }

  stat(path: string): KernelStat {
    this.#assertOpen();
    return this.#paths.stat(path);
  }

  lstat(path: string): KernelStat {
    this.#assertOpen();
    return this.#paths.lstat(path);
  }

  fstat(fd: number): KernelStat {
    this.#assertOpen();
    return this.#paths.fstat(fd);
  }

  truncate(path: string, size: bigint): void {
    this.#assertOpen();
    this.#paths.truncate(path, size);
  }

  ftruncate(fd: number, size: bigint): void {
    this.#assertOpen();
    this.#io.ftruncate(fd, size);
  }

  mkdir(path: string): void {
    this.#assertOpen();
    this.#paths.mkdir(path);
  }

  readdir(path: string): string[] {
    this.#assertOpen();
    return this.#paths.readdir(path);
  }

  readlink(path: string): string {
    this.#assertOpen();
    return this.#paths.readlink(path);
  }

  symlink(target: string, path: string): void {
    this.#assertOpen();
    this.#paths.symlink(target, path);
  }

  link(sourcePath: string, targetPath: string): void {
    this.#assertOpen();
    this.#paths.link(sourcePath, targetPath);
  }

  rename(sourcePath: string, targetPath: string): void {
    this.#assertOpen();
    this.#paths.rename(sourcePath, targetPath);
  }

  unlink(path: string): void {
    this.#assertOpen();
    this.#paths.unlink(path);
  }

  rmdir(path: string): void {
    this.#assertOpen();
    this.#paths.rmdir(path);
  }

  setTimes(path: string, times: Times, follow = true): void {
    this.#assertOpen();
    this.#paths.setTimes(path, times, follow);
  }

  fsetTimes(fd: number, times: Times): void {
    this.#assertOpen();
    this.#paths.fsetTimes(fd, times);
  }

  sync(fd: number, dataOnly = false): void {
    this.#assertOpen();
    this.#io.sync(fd, dataOnly);
  }

  realpath(path: string): string {
    this.#assertOpen();
    return this.#paths.realpath(path);
  }

  chdir(path: string): void {
    this.#assertOpen();
    const resolved = this.#paths.resolve(path);
    this.#setCwdAnchor(anchorFromResolved(resolved));
  }

  fchdir(fd: number): void {
    this.#assertOpen();
    const descriptor = withKernelErrors(() => this.descriptors.get(fd));
    if (
      descriptor.kind !== "directory" ||
      descriptor.mount === undefined ||
      descriptor.inode === undefined ||
      descriptor.ancestors === undefined ||
      descriptor.pathComponents === undefined
    ) {
      throw kernelError("ENOTDIR");
    }
    this.#setCwdAnchor({
      mount: descriptor.mount,
      inode: descriptor.inode,
      ancestors: descriptor.ancestors,
      pathComponents: descriptor.pathComponents,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    if (this.#ownsDescriptors) {
      try {
        withKernelErrors(() => runSync(this.#wasi.close()));
      } catch (error) {
        errors.push(error);
      }
    }
    const cwdAnchor = this.#cwdAnchor;
    this.#cwdAnchor = undefined;
    if (cwdAnchor !== undefined) {
      try {
        runKernelSync(cwdAnchor.mount.storage.release(cwdAnchor.inode));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Kernel filesystem disposal failed");
  }

  #assertOpen(): void {
    if (this.#disposed)
      throw Object.assign(new Error("Kernel filesystem is disposed"), { code: "EBADF" });
  }

  #retainCwdAnchor(anchor: WasiPathAnchor): void {
    const snapshot = copyAnchor(anchor);
    runKernelSync(snapshot.mount.storage.retain(snapshot.inode));
    this.#cwdAnchor = snapshot;
  }

  #setCwdAnchor(anchor: WasiPathAnchor): void {
    const snapshot = copyAnchor(anchor);
    runKernelSync(snapshot.mount.storage.retain(snapshot.inode));
    try {
      this.#paths.resolver.setCwdFromAnchor(snapshot);
    } catch (error) {
      try {
        runKernelSync(snapshot.mount.storage.release(snapshot.inode));
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Working directory update and cleanup failed",
          { cause: releaseError },
        );
      }
      throw error;
    }

    const previous = this.#cwdAnchor;
    this.#cwdAnchor = this.#paths.resolver.cwdAnchor ?? snapshot;
    if (previous !== undefined) runKernelSync(previous.mount.storage.release(previous.inode));
  }
}

function anchorFromResolved(resolved: WasiResolvedPath): WasiPathAnchor {
  return {
    mount: resolved.mount,
    inode: resolved.inode,
    ancestors: [...resolved.ancestors],
    pathComponents: [...resolved.pathComponents],
  };
}

function copyAnchor(anchor: WasiPathAnchor): WasiPathAnchor {
  return {
    mount: anchor.mount,
    inode: anchor.inode,
    ancestors: [...anchor.ancestors],
    pathComponents: [...anchor.pathComponents],
  };
}

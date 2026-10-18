import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { WasiMemory } from "../wasi/internal_wasi_memory.ts";
import { mapErrno } from "../wasi/internal_wasi_calls.ts";
import { kernelError } from "./KernelFileSystemErrors.ts";

// The import names and signatures come from AgentOS toolchain/crates/wasi-ext
// at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.

const EFAULT = 21;
const EINVAL = 28;
const EIO = 29;
const ENOTSUP = 58;
const AT_CWD = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;

export interface AgentOsFileSystemHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly fileSystem: KernelFileSystem;
}

export interface AgentOsFileSystemImports {
  set_open_mode: (mode: number) => number;
  fd_mode: (fd: number) => number;
  path_mode: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
  ) => number;
  fd_size: (fd: number) => bigint;
  fd_blocks: (fd: number) => bigint;
  fd_owner: (fd: number, uidPointer: number, gidPointer: number) => number;
  ftruncate: (fd: number, length: bigint) => number;
  open_tmpfile: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    flags: number,
    mode: number,
    fdPointer: number,
  ) => number;
  set_open_direct: (enabled: number) => number;
  path_access: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    mode: number,
    effectiveIds: number,
  ) => number;
  path_size: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
  ) => bigint;
  path_blocks: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
  ) => bigint;
  path_owner: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
    uidPointer: number,
    gidPointer: number,
  ) => number;
  fd_link: (fd: number, newDirFd: number, pathPointer: number, pathLength: number) => number;
  fchmod: (fd: number, mode: number) => number;
}

/**
 * The pinned ABI uses 0 for unavailable modes and UINT64_MAX for unavailable
 * sizes or blocks. Errno-returning imports use ENOTSUP when KernelFileSystem
 * has no operation for them.
 */
export class AgentOsFileSystemOperations {
  readonly imports: AgentOsFileSystemImports;
  readonly #options: AgentOsFileSystemHostOptions;

  constructor(options: AgentOsFileSystemHostOptions) {
    this.#options = options;
    const imports: AgentOsFileSystemImports = {
      set_open_mode: (_mode) => ENOTSUP,
      fd_mode: (_fd) => 0,
      path_mode: (_dirFd, pathPointer, pathLength, _followSymlinks) =>
        this.#unsupportedPathMetadata(pathPointer, pathLength, 0),
      fd_size: (fd) => this.#fdSize(fd),
      fd_blocks: (_fd) => UINT64_MAX,
      fd_owner: (fd, uidPointer, gidPointer) => this.#fdOwner(fd, uidPointer, gidPointer),
      ftruncate: (fd, length) => this.#errno(() => options.fileSystem.ftruncate(fd >>> 0, length)),
      open_tmpfile: (dirFd, pathPointer, pathLength, _flags, _mode, fdPointer) =>
        this.#openTmpfile(dirFd, pathPointer, pathLength, fdPointer),
      set_open_direct: (_enabled) => ENOTSUP,
      path_access: (dirFd, pathPointer, pathLength, mode, _effectiveIds) =>
        this.#pathAccess(dirFd, pathPointer, pathLength, mode),
      path_size: (dirFd, pathPointer, pathLength, followSymlinks) =>
        this.#pathSize(dirFd, pathPointer, pathLength, followSymlinks),
      path_blocks: (_dirFd, pathPointer, pathLength, _followSymlinks) =>
        this.#unsupportedPathMetadata(pathPointer, pathLength, UINT64_MAX),
      path_owner: (dirFd, pathPointer, pathLength, followSymlinks, uidPointer, gidPointer) =>
        this.#pathOwner(dirFd, pathPointer, pathLength, followSymlinks, uidPointer, gidPointer),
      fd_link: (fd, newDirFd, pathPointer, pathLength) =>
        this.#linkFd(fd, newDirFd, pathPointer, pathLength),
      fchmod: (fd, _mode) => this.#unsupportedDescriptorMutation(fd),
    };
    this.imports = Object.freeze(imports);
  }

  #fdSize(fd: number): bigint {
    try {
      return this.#options.fileSystem.fstat(fd >>> 0).size;
    } catch {
      return UINT64_MAX;
    }
  }

  #pathSize(
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
  ): bigint {
    try {
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      return this.#resolvePath(dirFd, path, followSymlinks >>> 0 !== 0).stat.size;
    } catch {
      return UINT64_MAX;
    }
  }

  #fdOwner(fd: number, uidPointer: number, gidPointer: number): number {
    const memory = this.#memory();
    if (!this.#validRange(memory, uidPointer, 4) || !this.#validRange(memory, gidPointer, 4)) {
      return EFAULT;
    }
    try {
      this.#options.fileSystem.fstat(fd >>> 0);
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #pathOwner(
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
    uidPointer: number,
    gidPointer: number,
  ): number {
    const memory = this.#memory();
    if (!this.#validRange(memory, uidPointer, 4) || !this.#validRange(memory, gidPointer, 4)) {
      return EFAULT;
    }
    try {
      const path = this.#readPath(memory, pathPointer, pathLength);
      this.#resolvePath(dirFd, path, followSymlinks >>> 0 !== 0, dirFd >>> 0 === AT_CWD);
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #pathAccess(dirFd: number, pathPointer: number, pathLength: number, mode: number): number {
    try {
      if (((mode >>> 0) & ~7) !== 0) return EINVAL;
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      this.#resolvePath(dirFd, path, true);
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #openTmpfile(dirFd: number, pathPointer: number, pathLength: number, fdPointer: number): number {
    const memory = this.#memory();
    if (!this.#validRange(memory, fdPointer, 4)) return EFAULT;
    try {
      const path = this.#readPath(memory, pathPointer, pathLength);
      const directory = this.#resolvePath(dirFd, path, true);
      if (directory.stat.type !== "directory") throw kernelError("ENOTDIR");
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #linkFd(fd: number, newDirFd: number, pathPointer: number, pathLength: number): number {
    try {
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      this.#options.fileSystem.fstat(fd >>> 0);
      if (!path.startsWith("/")) {
        this.#withAnchoredDirectory(newDirFd, () => undefined);
      }
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #unsupportedDescriptorMutation(fd: number): number {
    try {
      this.#options.fileSystem.fstat(fd >>> 0);
      return ENOTSUP;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #unsupportedPathMetadata<T extends number | bigint>(
    pathPointer: number,
    pathLength: number,
    sentinel: T,
  ): T {
    try {
      this.#readPath(this.#memory(), pathPointer, pathLength);
    } catch {
      // The value-returning ABI has no errno channel; it uses the same
      // unavailable sentinel for a bad path and for absent metadata.
    }
    return sentinel;
  }

  #resolvePath(dirFd: number, path: string, followFinal: boolean, allowCwd = false) {
    if (path.startsWith("/") || (allowCwd && dirFd >>> 0 === AT_CWD)) {
      return this.#options.fileSystem.resolve(path, { followFinal });
    }

    return this.#withAnchoredDirectory(dirFd, (anchored) =>
      anchored.resolve(path, { followFinal }),
    );
  }

  #withAnchoredDirectory<T>(dirFd: number, operation: (anchored: KernelFileSystem) => T): T {
    const anchored = this.#options.fileSystem.fork(this.#options.fileSystem.descriptors);
    try {
      anchored.fchdir(dirFd >>> 0);
      return operation(anchored);
    } finally {
      anchored.dispose();
    }
  }

  #readPath(memory: WasiMemory, pointer: number, length: number): string {
    return memory.string(pointer, length);
  }

  #memory(): WasiMemory {
    const memory = new WasiMemory();
    memory.set(this.#options.memory());
    return memory;
  }

  #validRange(memory: WasiMemory, pointer: number, length: number): boolean {
    try {
      memory.range(pointer, length);
      return true;
    } catch {
      return false;
    }
  }

  #errno(operation: () => void): number {
    try {
      operation();
      return 0;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #toErrno(error: unknown): number {
    try {
      return mapErrno(error);
    } catch {
      return EIO;
    }
  }
}

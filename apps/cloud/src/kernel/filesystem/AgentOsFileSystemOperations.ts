import type { KernelFileSystem, KernelStat } from "../KernelFileSystem.ts";
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
const MODE_MASK = 0o7777;
const CHOWN_UNCHANGED = 0xffff_ffff;
const TYPE_MODE_BITS: Readonly<Record<KernelStat["type"], number>> = {
  file: 0o100000,
  directory: 0o040000,
  symlink: 0o120000,
  character: 0o020000,
};

export interface AgentOsFileSystemHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly fileSystem: KernelFileSystem;
  /** Enables AgentOS's tagged hidden-preopen operands for path operations. */
  readonly agentOsPreopens?: boolean;
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
  fd_chown: (fd: number, uid: number, gid: number) => number;
  path_chown: (
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    uid: number,
    gid: number,
    followSymlinks: number,
  ) => number;
  chmod: (dirFd: number, pathPointer: number, pathLength: number, mode: number) => number;
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
      set_open_mode: (mode) =>
        this.#errno(() => options.fileSystem.setNextCreateMode(mode & MODE_MASK)),
      fd_mode: (fd) => this.#fdMode(fd),
      path_mode: (dirFd, pathPointer, pathLength, followSymlinks) =>
        this.#pathMode(dirFd, pathPointer, pathLength, followSymlinks),
      fd_size: (fd) => this.#fdSize(fd),
      fd_blocks: (_fd) => UINT64_MAX,
      fd_owner: (fd, uidPointer, gidPointer) => this.#fdOwner(fd, uidPointer, gidPointer),
      fd_chown: (fd, uid, gid) => this.#fdChown(fd, uid, gid),
      path_chown: (dirFd, pathPointer, pathLength, uid, gid, followSymlinks) =>
        this.#pathChown(dirFd, pathPointer, pathLength, uid, gid, followSymlinks),
      chmod: (dirFd, pathPointer, pathLength, mode) =>
        this.#pathChmod(dirFd, pathPointer, pathLength, mode),
      ftruncate: (fd, length) => this.#errno(() => options.fileSystem.ftruncate(fd >>> 0, length)),
      open_tmpfile: (dirFd, pathPointer, pathLength, _flags, _mode, fdPointer) =>
        this.#openTmpfile(dirFd, pathPointer, pathLength, fdPointer),
      set_open_direct: (_enabled) => ENOTSUP,
      path_access: (dirFd, pathPointer, pathLength, mode, effectiveIds) =>
        this.#pathAccess(dirFd, pathPointer, pathLength, mode, effectiveIds),
      path_size: (dirFd, pathPointer, pathLength, followSymlinks) =>
        this.#pathSize(dirFd, pathPointer, pathLength, followSymlinks),
      path_blocks: (_dirFd, pathPointer, pathLength, _followSymlinks) =>
        this.#unsupportedPathMetadata(pathPointer, pathLength, UINT64_MAX),
      path_owner: (dirFd, pathPointer, pathLength, followSymlinks, uidPointer, gidPointer) =>
        this.#pathOwner(dirFd, pathPointer, pathLength, followSymlinks, uidPointer, gidPointer),
      fd_link: (fd, newDirFd, pathPointer, pathLength) =>
        this.#linkFd(fd, newDirFd, pathPointer, pathLength),
      fchmod: (fd, mode) =>
        this.#errno(() => options.fileSystem.fchmod(fd >>> 0, mode & MODE_MASK)),
    };
    this.imports = Object.freeze(imports);
  }

  #fdMode(fd: number): number {
    try {
      const descriptor = fd >>> 0;
      const stat = this.#options.fileSystem.fstat(descriptor);
      const metadata = this.#options.fileSystem.getPosixMetadataForFd(descriptor);
      return this.#modeBits(stat.type, metadata.mode);
    } catch {
      // This value-returning ABI uses zero for invalid fds and unknown metadata.
      return 0;
    }
  }

  #pathMode(
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    followSymlinks: number,
  ): number {
    try {
      const memory = this.#memory();
      const path = this.#readPath(memory, pathPointer, pathLength);
      return this.#withPath(dirFd, path, (fileSystem) => {
        const stat = followSymlinks >>> 0 !== 0 ? fileSystem.stat(path) : fileSystem.lstat(path);
        const metadata = fileSystem.getPosixMetadata(path, followSymlinks >>> 0 !== 0);
        return this.#modeBits(stat.type, metadata.mode);
      });
    } catch {
      // This value-returning ABI uses zero for invalid paths and unknown metadata.
      return 0;
    }
  }

  #pathChmod(dirFd: number, pathPointer: number, pathLength: number, mode: number): number {
    try {
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      this.#withPath(dirFd, path, (fileSystem) => fileSystem.chmod(path, mode & MODE_MASK));
      return 0;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #fdChown(fd: number, uidBits: number, gidBits: number): number {
    try {
      const descriptor = fd >>> 0;
      const current = this.#options.fileSystem.getPosixMetadataForFd(descriptor);
      this.#options.fileSystem.fchown(
        descriptor,
        uidBits >>> 0 === CHOWN_UNCHANGED ? current.uid : uidBits >>> 0,
        gidBits >>> 0 === CHOWN_UNCHANGED ? current.gid : gidBits >>> 0,
      );
      return 0;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #pathChown(
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    uidBits: number,
    gidBits: number,
    followSymlinks: number,
  ): number {
    try {
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      this.#withPath(dirFd, path, (fileSystem) => {
        const follow = followSymlinks >>> 0 !== 0;
        const current = fileSystem.getPosixMetadata(path, follow);
        fileSystem.chown(
          path,
          uidBits >>> 0 === CHOWN_UNCHANGED ? current.uid : uidBits >>> 0,
          gidBits >>> 0 === CHOWN_UNCHANGED ? current.gid : gidBits >>> 0,
          follow,
        );
      });
      return 0;
    } catch (error) {
      return this.#toErrno(error);
    }
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
      return this.#withPath(
        dirFd,
        path,
        (fileSystem) =>
          (followSymlinks >>> 0 !== 0 ? fileSystem.stat(path) : fileSystem.lstat(path)).size,
      );
    } catch {
      return UINT64_MAX;
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
      // The value-returning ABI has no errno channel for an invalid path.
    }
    return sentinel;
  }

  #fdOwner(fd: number, uidPointer: number, gidPointer: number): number {
    const memory = this.#memory();
    if (!this.#validRange(memory, uidPointer, 4) || !this.#validRange(memory, gidPointer, 4)) {
      return EFAULT;
    }
    try {
      const metadata = this.#options.fileSystem.getPosixMetadataForFd(fd >>> 0);
      memory.u32(uidPointer, metadata.uid);
      memory.u32(gidPointer, metadata.gid);
      return 0;
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
      const owner = this.#withPath(dirFd, path, (fileSystem) =>
        fileSystem.getPosixMetadata(path, followSymlinks >>> 0 !== 0),
      );
      memory.u32(uidPointer, owner.uid);
      memory.u32(gidPointer, owner.gid);
      return 0;
    } catch (error) {
      return this.#toErrno(error);
    }
  }

  #pathAccess(
    dirFd: number,
    pathPointer: number,
    pathLength: number,
    mode: number,
    effectiveIds: number,
  ): number {
    try {
      if (((mode >>> 0) & ~7) !== 0) return EINVAL;
      if (effectiveIds !== 0 && effectiveIds !== 1) return EINVAL;
      const path = this.#readPath(this.#memory(), pathPointer, pathLength);
      const requested = mode >>> 0;
      this.#withPath(dirFd, path, (fileSystem) =>
        fileSystem.access(path, requested, effectiveIds === 1),
      );
      return 0;
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

  #resolvePath(dirFd: number, path: string, followFinal: boolean, allowCwd = true) {
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

  #withPath<T>(dirFd: number, path: string, operation: (fileSystem: KernelFileSystem) => T): T {
    if (path.startsWith("/") || dirFd >>> 0 === AT_CWD) {
      return operation(this.#options.fileSystem);
    }
    return this.#withAnchoredDirectory(dirFd, operation);
  }

  #modeBits(type: KernelStat["type"], permissions: number): number {
    return TYPE_MODE_BITS[type] | (permissions & MODE_MASK);
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

import type { KernelFileSystem, KernelPosixMetadata, KernelStat } from "../KernelFileSystem.ts";
import { KERNEL_GIT_MAX_PATH_BYTES } from "../KernelGitMemoryPlan.ts";
import { mapErrno } from "../wasi/internal_wasi_calls.ts";
import type { KernelGitCredentials } from "./KernelGitCredentials.ts";
import {
  gitMemoryRange,
  gitMemoryView,
  validGitMemoryRange,
  type KernelGitMemory,
} from "./KernelGitProcessWire.ts";

const EFAULT = 21;
const EINVAL = 28;
const ENOTSUP = 58;
const AT_FDCWD = -100;
const LOOKUP_SYMLINK_FOLLOW = 1;

const decoder = new TextDecoder("utf-8", { fatal: true });

interface GitFilesystemImportOptions {
  readonly memory: () => KernelGitMemory;
  readonly filesystem: KernelFileSystem;
  readonly credentials: KernelGitCredentials;
}

interface GitStat {
  readonly stat: KernelStat;
  readonly metadata: KernelPosixMetadata;
}

/** Nimbus's stat ABI over the same inode store used by KernelFileSystem. */
export class KernelGitFilesystemImports {
  readonly imports: Readonly<Record<string, WebAssembly.ImportValue>>;
  readonly #options: GitFilesystemImportOptions;

  constructor(options: GitFilesystemImportOptions) {
    assertFilesystemCredentials(options.filesystem, options.credentials);
    this.#options = options;
    this.imports = Object.freeze({
      path_stat: (
        dirFd: number,
        lookupFlags: number,
        pathPointer: number,
        pathLength: number,
        outPointer: number,
      ) => this.#pathStat(dirFd, lookupFlags, pathPointer, pathLength, outPointer),
      fd_stat: (fd: number, outPointer: number) => this.#fdStat(fd, outPointer),
      path_chmod: (
        dirFd: number,
        lookupFlags: number,
        pathPointer: number,
        pathLength: number,
        mode: number,
      ) => this.#pathChmod(dirFd, lookupFlags, pathPointer, pathLength, mode),
      fd_chmod: (fd: number, mode: number) => this.#fdChmod(fd, mode),
      umask: (mask: number, previousPointer: number) => this.#setUmask(mask, previousPointer),
      path_access: (
        dirFd: number,
        lookupFlags: number,
        pathPointer: number,
        pathLength: number,
        mode: number,
      ) => this.#pathAccess(dirFd, lookupFlags, pathPointer, pathLength, mode),
    });
  }

  #pathStat(
    dirFd: number,
    lookupFlags: number,
    pathPointer: number,
    pathLength: number,
    outPointer: number,
  ) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, outPointer, 80)) return EFAULT;
    let output: DataView;
    try {
      output = gitMemoryView(memory, outPointer, 80);
    } catch {
      return EFAULT;
    }
    const path = this.#readPath(memory, pathPointer, pathLength);
    if (typeof path === "number") return path;
    if (path.length === 0) return 44;
    try {
      const record = this.#withDirectory(dirFd | 0, path, (filesystem) =>
        statAt(filesystem, path, ((lookupFlags >>> 0) & LOOKUP_SYMLINK_FOLLOW) !== 0),
      );
      this.#writeStat(output, record);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #fdStat(fd: number, outPointer: number) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, outPointer, 80)) return EFAULT;
    try {
      const output = gitMemoryView(memory, outPointer, 80);
      const filesystem = this.#options.filesystem;
      const descriptor = fd >>> 0;
      this.#writeStat(output, {
        stat: filesystem.fstat(descriptor),
        metadata: filesystem.getPosixMetadataForFd(descriptor),
      });
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #pathChmod(
    dirFd: number,
    lookupFlags: number,
    pathPointer: number,
    pathLength: number,
    mode: number,
  ) {
    if (((lookupFlags >>> 0) & LOOKUP_SYMLINK_FOLLOW) === 0) return ENOTSUP;
    const path = this.#readPath(this.#options.memory(), pathPointer, pathLength);
    if (typeof path === "number") return path;
    try {
      this.#withDirectory(dirFd | 0, path, (filesystem) =>
        filesystem.chmod(path, (mode >>> 0) & 0o7777),
      );
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #fdChmod(fd: number, mode: number) {
    try {
      this.#options.filesystem.fchmod(fd >>> 0, (mode >>> 0) & 0o7777);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #setUmask(mask: number, previousPointer: number) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, previousPointer, 4)) return EFAULT;
    let output: DataView;
    try {
      output = gitMemoryView(memory, previousPointer, 4);
    } catch {
      return EFAULT;
    }
    const next = mask >>> 0;
    if ((next & ~0o777) !== 0) return EINVAL;
    try {
      const previous = this.#options.filesystem.setUmask(next);
      output.setUint32(0, previous, true);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #pathAccess(
    dirFd: number,
    lookupFlags: number,
    pathPointer: number,
    pathLength: number,
    mode: number,
  ) {
    void lookupFlags;
    const requested = mode >>> 0;
    const path = this.#readPath(this.#options.memory(), pathPointer, pathLength);
    if (typeof path === "number") return path;
    if (path.length === 0) return 44;
    try {
      this.#withDirectory(dirFd | 0, path, (filesystem) => filesystem.access(path, requested));
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #withDirectory<T>(
    dirFd: number,
    path: string,
    operation: (filesystem: KernelFileSystem) => T,
  ): T {
    const filesystem = this.#options.filesystem;
    const anchored =
      !path.startsWith("/") && dirFd !== AT_FDCWD
        ? filesystem.fork(filesystem.descriptors)
        : undefined;
    try {
      if (anchored !== undefined) anchored.fchdir(dirFd >>> 0);
      return operation(anchored ?? filesystem);
    } finally {
      anchored?.dispose();
    }
  }

  #readPath(memory: KernelGitMemory, pointer: number, length: number): string | number {
    const start = pointer >>> 0;
    const size = length >>> 0;
    if (size > KERNEL_GIT_MAX_PATH_BYTES) return EINVAL;
    if (!validGitMemoryRange(memory, start, size)) return EFAULT;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = gitMemoryRange(memory, start, size);
    } catch {
      return EFAULT;
    }
    if (bytes.includes(0)) return EINVAL;
    try {
      return decoder.decode(bytes);
    } catch {
      return EINVAL;
    }
  }

  #writeStat(view: DataView, record: GitStat) {
    const { stat, metadata } = record;
    view.setBigUint64(0, stat.dev, true);
    view.setBigUint64(8, stat.ino, true);
    view.setUint8(16, fileType(stat.type));
    view.setBigUint64(24, stat.nlink, true);
    view.setBigUint64(32, stat.size, true);
    view.setBigUint64(40, stat.atimeNs, true);
    view.setBigUint64(48, stat.mtimeNs, true);
    view.setBigUint64(56, stat.ctimeNs, true);
    view.setUint32(64, fileTypeMode(stat.type) | (metadata.mode & 0o7777), true);
    view.setUint32(68, metadata.uid, true);
    view.setUint32(72, metadata.gid, true);
    view.setUint32(76, 0, true);
  }
}

function assertFilesystemCredentials(
  filesystem: KernelFileSystem,
  credentials: KernelGitCredentials,
): void {
  const policy = filesystem.posixPolicy;
  if (policy === undefined)
    throw new RangeError("Git requires explicit filesystem POSIX credentials");
  const actual = policy.credentials;
  if (
    credentials.uid !== actual.uid ||
    credentials.gid !== actual.gid ||
    credentials.euid !== actual.euid ||
    credentials.egid !== actual.egid
  ) {
    throw new RangeError("Git credentials must match the filesystem POSIX identity");
  }
}

function statAt(filesystem: KernelFileSystem, path: string, follow: boolean): GitStat {
  return {
    stat: follow ? filesystem.stat(path) : filesystem.lstat(path),
    metadata: filesystem.getPosixMetadata(path, follow),
  };
}

function fileType(type: KernelStat["type"]): number {
  switch (type) {
    case "directory":
      return 3;
    case "file":
      return 4;
    case "symlink":
      return 7;
    case "character":
      return 2;
  }
}

function fileTypeMode(type: KernelStat["type"]): number {
  switch (type) {
    case "directory":
      return 0o040000;
    case "file":
      return 0o100000;
    case "symlink":
      return 0o120000;
    case "character":
      return 0o020000;
  }
}

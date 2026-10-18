import type { KernelFileSystem, KernelPosixMetadata, KernelStat } from "../KernelFileSystem.ts";
import { mapErrno } from "../wasi/internal_wasi_calls.ts";
import { validRange } from "../process/AgentOsDescriptorSupport.ts";
import type { KernelGitCredentials } from "./KernelGitCredentials.ts";

const EFAULT = 21;
const EINVAL = 28;
const ENOTSUP = 58;
const AT_FDCWD = -100;
const LOOKUP_SYMLINK_FOLLOW = 1;
const MAX_PATH_BYTES = 1_048_576;

const decoder = new TextDecoder("utf-8", { fatal: true });

interface GitFilesystemImportOptions {
  readonly memory: () => WebAssembly.Memory;
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
    if (!validRange(memory, outPointer, 80)) return EFAULT;
    const path = this.#readPath(memory, pathPointer, pathLength);
    if (typeof path === "number") return path;
    if (path.length === 0) return 44;
    try {
      const record = this.#withDirectory(dirFd | 0, path, (filesystem) =>
        statAt(filesystem, path, ((lookupFlags >>> 0) & LOOKUP_SYMLINK_FOLLOW) !== 0),
      );
      this.#writeStat(memory, outPointer, record);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #fdStat(fd: number, outPointer: number) {
    const memory = this.#options.memory();
    if (!validRange(memory, outPointer, 80)) return EFAULT;
    try {
      const filesystem = this.#options.filesystem;
      const descriptor = fd >>> 0;
      this.#writeStat(memory, outPointer, {
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
    if (!validRange(memory, previousPointer, 4)) return EFAULT;
    const next = mask >>> 0;
    if ((next & ~0o777) !== 0) return EINVAL;
    try {
      const previous = this.#options.filesystem.setUmask(next);
      new DataView(memory.buffer).setUint32(previousPointer >>> 0, previous, true);
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

  #readPath(memory: WebAssembly.Memory, pointer: number, length: number): string | number {
    const start = pointer >>> 0;
    const size = length >>> 0;
    if (size > MAX_PATH_BYTES) return EINVAL;
    if (!validRange(memory, start, size)) return EFAULT;
    const bytes = new Uint8Array(memory.buffer, start, size);
    if (bytes.includes(0)) return EINVAL;
    try {
      return decoder.decode(bytes);
    } catch {
      return EINVAL;
    }
  }

  #writeStat(memory: WebAssembly.Memory, pointer: number, record: GitStat) {
    const { stat, metadata } = record;
    const view = new DataView(memory.buffer);
    const start = pointer >>> 0;
    view.setBigUint64(start, stat.dev, true);
    view.setBigUint64(start + 8, stat.ino, true);
    view.setUint8(start + 16, fileType(stat.type));
    view.setBigUint64(start + 24, stat.nlink, true);
    view.setBigUint64(start + 32, stat.size, true);
    view.setBigUint64(start + 40, stat.atimeNs, true);
    view.setBigUint64(start + 48, stat.mtimeNs, true);
    view.setBigUint64(start + 56, stat.ctimeNs, true);
    view.setUint32(start + 64, fileTypeMode(stat.type) | (metadata.mode & 0o7777), true);
    view.setUint32(start + 68, metadata.uid, true);
    view.setUint32(start + 72, metadata.gid, true);
    view.setUint32(start + 76, 0, true);
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

import { FDFLAGS, READ_ONLY_RIGHTS, RIGHTS } from "../wasi/internal_wasi_descriptors.ts";
import type { Stat } from "../storage.ts";
import { kernelError } from "./KernelFileSystemErrors.ts";

/** Linux x86_64 values stay stable even when this code runs on macOS. */
export const KernelOpenFlags = Object.freeze({
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_ACCMODE: 3,
  O_CREAT: 0x40,
  O_EXCL: 0x80,
  O_NOCTTY: 0x100,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
  O_NONBLOCK: 0x800,
  O_DSYNC: 0x1000,
  O_ASYNC: 0x2000,
  O_DIRECT: 0x4000,
  O_LARGEFILE: 0x8000,
  O_DIRECTORY: 0x10000,
  O_NOFOLLOW: 0x20000,
  O_NOATIME: 0x40000,
  O_CLOEXEC: 0x80000,
  O_SYNC: 0x101000,
  O_RSYNC: 0x101000,
  O_PATH: 0x200000,
});

export type KernelOpenFlagsValue = (typeof KernelOpenFlags)[keyof typeof KernelOpenFlags];

export interface ParsedOpenFlags {
  readonly accessMode: 0 | 1 | 2;
  readonly pathOnly: boolean;
  readonly create: boolean;
  readonly exclusive: boolean;
  readonly truncate: boolean;
  readonly directory: boolean;
  readonly noFollow: boolean;
  readonly closeOnExec: boolean;
  readonly statusFlags: number;
  readonly rightsBase: bigint;
}

const supportedMask = [
  KernelOpenFlags.O_ACCMODE,
  KernelOpenFlags.O_CREAT,
  KernelOpenFlags.O_EXCL,
  KernelOpenFlags.O_NOCTTY,
  KernelOpenFlags.O_TRUNC,
  KernelOpenFlags.O_APPEND,
  KernelOpenFlags.O_NONBLOCK,
  KernelOpenFlags.O_DSYNC,
  KernelOpenFlags.O_LARGEFILE,
  KernelOpenFlags.O_DIRECTORY,
  KernelOpenFlags.O_NOFOLLOW,
  KernelOpenFlags.O_NOATIME,
  KernelOpenFlags.O_CLOEXEC,
  KernelOpenFlags.O_SYNC,
  KernelOpenFlags.O_PATH,
].reduce((all, bit) => all | bit, 0);

export function parseOpenFlags(flags: number): ParsedOpenFlags {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~supportedMask) !== 0) {
    throw kernelError("ENOTSUP", "Unsupported Linux open flags");
  }
  const accessMode = (flags & KernelOpenFlags.O_ACCMODE) as 0 | 1 | 2 | 3;
  if (accessMode === 3) throw kernelError("EINVAL");

  const pathOnly = (flags & KernelOpenFlags.O_PATH) !== 0;
  if (!pathOnly && (flags & KernelOpenFlags.O_NONBLOCK) !== 0) {
    throw kernelError("ENOTSUP", "Nonblocking filesystem descriptors are unsupported");
  }
  if (!pathOnly && (flags & KernelOpenFlags.O_ASYNC) !== 0) {
    throw kernelError("ENOTSUP", "Asynchronous filesystem descriptors are unsupported");
  }
  if (!pathOnly && (flags & KernelOpenFlags.O_DIRECT) !== 0) {
    throw kernelError("ENOTSUP", "Direct I/O is unsupported");
  }

  const readable = pathOnly || accessMode !== KernelOpenFlags.O_WRONLY;
  const writable = !pathOnly && accessMode !== KernelOpenFlags.O_RDONLY;
  let rightsBase = RIGHTS.FD_FILESTAT_GET;
  let statusFlags = 0;
  if (!pathOnly) {
    rightsBase |=
      RIGHTS.FD_FDSTAT_SET_FLAGS |
      RIGHTS.FD_SYNC |
      RIGHTS.FD_DATASYNC |
      RIGHTS.FD_FILESTAT_SET_TIMES;
    if (readable) rightsBase |= RIGHTS.FD_READ | RIGHTS.FD_SEEK | RIGHTS.FD_TELL;
    if (writable) {
      rightsBase |= RIGHTS.FD_WRITE | RIGHTS.FD_ALLOCATE | RIGHTS.FD_FILESTAT_SET_SIZE;
    }
    if ((flags & KernelOpenFlags.O_APPEND) !== 0) statusFlags |= FDFLAGS.APPEND;
    if ((flags & KernelOpenFlags.O_DSYNC) !== 0) statusFlags |= FDFLAGS.DSYNC;
    if ((flags & KernelOpenFlags.O_SYNC) === KernelOpenFlags.O_SYNC) {
      statusFlags |= FDFLAGS.SYNC;
    }
  }

  return {
    accessMode,
    pathOnly,
    create: !pathOnly && (flags & KernelOpenFlags.O_CREAT) !== 0,
    exclusive: (flags & KernelOpenFlags.O_EXCL) !== 0,
    truncate: !pathOnly && (flags & KernelOpenFlags.O_TRUNC) !== 0,
    directory: (flags & KernelOpenFlags.O_DIRECTORY) !== 0,
    noFollow: (flags & KernelOpenFlags.O_NOFOLLOW) !== 0,
    closeOnExec: (flags & KernelOpenFlags.O_CLOEXEC) !== 0,
    statusFlags,
    rightsBase,
  };
}

const DIRECTORY_RIGHTS =
  RIGHTS.PATH_CREATE_DIRECTORY |
  RIGHTS.PATH_CREATE_FILE |
  RIGHTS.PATH_LINK_SOURCE |
  RIGHTS.PATH_LINK_TARGET |
  RIGHTS.PATH_OPEN |
  RIGHTS.FD_READDIR |
  RIGHTS.PATH_READLINK |
  RIGHTS.PATH_RENAME_SOURCE |
  RIGHTS.PATH_RENAME_TARGET |
  RIGHTS.PATH_FILESTAT_GET |
  RIGHTS.PATH_FILESTAT_SET_SIZE |
  RIGHTS.PATH_FILESTAT_SET_TIMES |
  RIGHTS.PATH_SYMLINK |
  RIGHTS.PATH_REMOVE_DIRECTORY |
  RIGHTS.PATH_UNLINK_FILE;

export function descriptorRights(
  flags: ParsedOpenFlags,
  type: Stat["type"],
  readOnly: boolean,
): { readonly base: bigint; readonly inheriting: bigint } {
  let base = flags.rightsBase;
  let inheriting = 0n;
  if (type === "directory") {
    base |= DIRECTORY_RIGHTS;
    if (!flags.pathOnly) base |= RIGHTS.FD_READDIR;
    inheriting = base;
  } else if (flags.pathOnly) {
    base = RIGHTS.FD_FILESTAT_GET;
  }
  if (readOnly) {
    base &= READ_ONLY_RIGHTS;
    inheriting &= READ_ONLY_RIGHTS;
  }
  return { base, inheriting };
}

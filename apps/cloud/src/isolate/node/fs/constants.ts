/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import { KernelOpenFlags } from "../../../kernel/KernelFileSystem.ts";

export { KernelOpenFlags };

const kernelOpenFlagConstants = Object.fromEntries(
  Object.entries(KernelOpenFlags).filter(
    ([name, value]) => name.startsWith("O_") && typeof value === "number",
  ),
);

const posixFsConstants = Object.freeze({
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  F_OK: 0,
  R_OK: 4,
  S_IFBLK: 0o060000,
  S_IFCHR: 0o020000,
  S_IFDIR: 0o040000,
  S_IFIFO: 0o010000,
  S_IFLNK: 0o120000,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFSOCK: 0o140000,
  S_ISGID: 0o002000,
  S_ISUID: 0o004000,
  S_ISVTX: 0o001000,
  S_IRGRP: 0o000040,
  S_IROTH: 0o000004,
  S_IRUSR: 0o000400,
  S_IRWXG: 0o000070,
  S_IRWXO: 0o000007,
  S_IRWXU: 0o000700,
  S_IWGRP: 0o000020,
  S_IWOTH: 0o000002,
  S_IWUSR: 0o000200,
  S_IXGRP: 0o000010,
  S_IXOTH: 0o000001,
  S_IXUSR: 0o000100,
  W_OK: 2,
  X_OK: 1,
});

export type NativeFsConstants = object;
export type FsConstants = Readonly<Record<string, number>>;

// Avoid importing node:fs here: the bundled alias for that specifier is this module.
export function createFsConstants(nativeConstants: NativeFsConstants = {}): FsConstants {
  return Object.freeze({
    ...posixFsConstants,
    ...nativeConstants,
    ...kernelOpenFlagConstants,
  }) as FsConstants;
}

export const fsConstants: FsConstants = createFsConstants();

const stringFlags: Readonly<Record<string, number>> = {
  r: KernelOpenFlags.O_RDONLY,
  "r+": KernelOpenFlags.O_RDWR,
  rs: KernelOpenFlags.O_RDONLY,
  "rs+": KernelOpenFlags.O_RDWR,
  w: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC,
  "w+": KernelOpenFlags.O_RDWR | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC,
  wx:
    KernelOpenFlags.O_WRONLY |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_TRUNC |
    KernelOpenFlags.O_EXCL,
  "wx+":
    KernelOpenFlags.O_RDWR |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_TRUNC |
    KernelOpenFlags.O_EXCL,
  xw:
    KernelOpenFlags.O_WRONLY |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_TRUNC |
    KernelOpenFlags.O_EXCL,
  "xw+":
    KernelOpenFlags.O_RDWR |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_TRUNC |
    KernelOpenFlags.O_EXCL,
  a: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_APPEND,
  "a+": KernelOpenFlags.O_RDWR | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_APPEND,
  ax:
    KernelOpenFlags.O_WRONLY |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_APPEND |
    KernelOpenFlags.O_EXCL,
  "ax+":
    KernelOpenFlags.O_RDWR |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_APPEND |
    KernelOpenFlags.O_EXCL,
  xa:
    KernelOpenFlags.O_WRONLY |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_APPEND |
    KernelOpenFlags.O_EXCL,
  "xa+":
    KernelOpenFlags.O_RDWR |
    KernelOpenFlags.O_CREAT |
    KernelOpenFlags.O_APPEND |
    KernelOpenFlags.O_EXCL,
};

export function parseOpenFlags(flags: string | number): number {
  if (typeof flags === "number") {
    if (!Number.isSafeInteger(flags) || flags < 0) {
      throw Object.assign(new RangeError("The file flags must be a non-negative safe integer"), {
        code: "ERR_OUT_OF_RANGE",
      });
    }
    return flags;
  }
  const parsed = Object.hasOwn(stringFlags, flags) ? stringFlags[flags] : undefined;
  if (parsed === undefined) {
    throw Object.assign(new TypeError(`Unknown file open flag: ${flags}`), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  return parsed;
}

export function normalizeMode(mode: number | undefined): number | undefined {
  if (mode === undefined) return undefined;
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw Object.assign(new RangeError('The "mode" argument must be a non-negative safe integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return mode;
}

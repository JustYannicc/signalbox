import type { KernelFileSystem } from "./KernelFileSystem.ts";

const HIDDEN_PREOPEN_FD_TAG = 0x4000_0000;
const HIDDEN_PREOPEN_FD_TAG_MASK = 0xc000_0000;
const HIDDEN_PREOPEN_FD_MASK = 0x3fff_ffff;

const FD_ARGUMENTS = Object.freeze({
  fd_fdstat_get: Object.freeze([0]),
  fd_prestat_get: Object.freeze([0]),
  fd_prestat_dir_name: Object.freeze([0]),
  path_create_directory: Object.freeze([0]),
  path_filestat_get: Object.freeze([0]),
  path_filestat_set_times: Object.freeze([0]),
  path_link: Object.freeze([0, 4]),
  path_open: Object.freeze([0]),
  path_readlink: Object.freeze([0]),
  path_remove_directory: Object.freeze([0]),
  path_rename: Object.freeze([0, 3]),
  path_symlink: Object.freeze([2]),
  path_unlink_file: Object.freeze([0]),
} satisfies Readonly<Record<string, readonly number[]>>);

// These slots carry libc's resolved path dirfd; fd_link's source fd stays explicit.
const HOST_FS_DIRECTORY_ARGUMENTS = Object.freeze({
  chmod: Object.freeze([0]),
  fd_link: Object.freeze([1]),
  open_tmpfile: Object.freeze([0]),
  path_access: Object.freeze([0]),
  path_blocks: Object.freeze([0]),
  path_chown: Object.freeze([0]),
  path_mode: Object.freeze([0]),
  path_owner: Object.freeze([0]),
  path_size: Object.freeze([0]),
} satisfies Readonly<Record<string, readonly number[]>>);

/** Adapts AgentOS's tagged hidden-preopen operands to this filesystem's real fds. */
export function createAgentOsWasiArgumentTransform(
  filesystem: Pick<KernelFileSystem, "descriptors">,
): (name: string, args: readonly (number | bigint)[]) => readonly (number | bigint)[] {
  return (name, args) => transformArguments(name, args, FD_ARGUMENTS, filesystem);
}

/** Maps only AgentOS host_fs path-directory operands, preserving descriptor operands. */
export function createAgentOsHostFsArgumentTransform(
  filesystem: Pick<KernelFileSystem, "descriptors">,
): (name: string, args: readonly (number | bigint)[]) => readonly (number | bigint)[] {
  return (name, args) => transformArguments(name, args, HOST_FS_DIRECTORY_ARGUMENTS, filesystem);
}

export function resolveHiddenPreopenFd(
  fd: number,
  filesystem: Pick<KernelFileSystem, "descriptors">,
): number {
  const unsignedFd = fd >>> 0;
  if ((unsignedFd & HIDDEN_PREOPEN_FD_TAG_MASK) !== HIDDEN_PREOPEN_FD_TAG) return fd;

  const preopenFd = unsignedFd & HIDDEN_PREOPEN_FD_MASK;
  try {
    const descriptor = filesystem.descriptors.get(preopenFd);
    return descriptor.kind === "directory" && descriptor.preopen === true ? preopenFd : fd;
  } catch {
    return fd;
  }
}

function transformArguments(
  name: string,
  args: readonly (number | bigint)[],
  argumentIndexes: Readonly<Record<string, readonly number[]>>,
  filesystem: Pick<KernelFileSystem, "descriptors">,
): readonly (number | bigint)[] {
  const indexes = argumentIndexes[name];
  if (indexes === undefined) return args;

  let transformed: (number | bigint)[] | undefined;
  for (const index of indexes) {
    const fd = args[index];
    if (typeof fd !== "number") continue;

    const preopenFd = resolveHiddenPreopenFd(fd, filesystem);
    if (preopenFd === fd) continue;
    transformed ??= [...args];
    transformed[index] = preopenFd;
  }
  return transformed ?? args;
}

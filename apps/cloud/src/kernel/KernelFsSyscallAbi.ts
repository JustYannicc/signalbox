/** Preview1 and existing Nimbus metadata operands used by the Node compatibility client. */
export interface KernelFsSyscallArguments {
  fd_close: [fd: number];
  fd_datasync: [fd: number];
  fd_sync: [fd: number];
  fd_renumber: [source: number, target: number];
  fd_seek: [fd: number, offset: bigint, whence: number, output: number];
  fd_tell: [fd: number, output: number];
  fd_filestat_get: [fd: number, output: number];
  fd_filestat_set_size: [fd: number, size: bigint];
  fd_filestat_set_times: [fd: number, atime: bigint, mtime: bigint, flags: number];
  fd_read: [fd: number, vectors: number, count: number, output: number];
  fd_write: [fd: number, vectors: number, count: number, output: number];
  fd_pread: [fd: number, vectors: number, count: number, offset: bigint, output: number];
  fd_pwrite: [fd: number, vectors: number, count: number, offset: bigint, output: number];
  fd_readdir: [fd: number, output: number, length: number, cookie: bigint, count: number];
  path_open: [
    fd: number,
    follow: number,
    path: number,
    length: number,
    flags: number,
    rights: bigint,
    inheritedRights: bigint,
    fdFlags: number,
    output: number,
  ];
  path_filestat_get: [fd: number, follow: number, path: number, length: number, output: number];
  path_filestat_set_times: [
    fd: number,
    follow: number,
    path: number,
    length: number,
    atime: bigint,
    mtime: bigint,
    flags: number,
  ];
  path_create_directory: [fd: number, path: number, length: number];
  path_remove_directory: [fd: number, path: number, length: number];
  path_unlink_file: [fd: number, path: number, length: number];
  path_readlink: [
    fd: number,
    path: number,
    length: number,
    output: number,
    capacity: number,
    count: number,
  ];
  path_symlink: [target: number, targetLength: number, fd: number, path: number, length: number];
  path_link: [
    sourceFd: number,
    follow: number,
    source: number,
    sourceLength: number,
    targetFd: number,
    target: number,
    targetLength: number,
  ];
  path_rename: [
    sourceFd: number,
    source: number,
    sourceLength: number,
    targetFd: number,
    target: number,
    targetLength: number,
  ];
  stat_metadata: [fd: number, path: number, length: number, follow: number, output: number];
  access: [path: number, length: number, mode: number, effectiveIds: number];
  realpath: [path: number, length: number, output: number, capacity: number, needed: number];
  chmod: [path: number, length: number, mode: number];
  fchmod: [fd: number, mode: number];
  chown: [fd: number, path: number, length: number, uid: number, gid: number, follow: number];
}

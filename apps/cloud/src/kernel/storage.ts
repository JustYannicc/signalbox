// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Storage identities are never reused during a backend's lifetime. */
export type Inode = bigint;

export interface Stat {
  type: 'file' | 'directory' | 'symlink';
  size: bigint;
  nlink: bigint;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface DirectoryEntry {
  name: string;
  inode: Inode;
  type: Stat['type'];
}

export interface CreateOptions {
  type: Stat['type'];
  exclusive: boolean;
  target?: string;
}

export interface Times {
  atimeNs?: bigint;
  mtimeNs?: bigint;
}

/**
 * Inode storage shared by filesystem adapters. Methods throw symbolic POSIX
 * errors using an Error's `code` property; unexpected exceptions propagate.
 * File sizes and offsets are in [0, 2^63 - 1]. Negative values fail with EINVAL,
 * overflow with EFBIG. Namespace mutations and append are atomic operations.
 *
 * Names contain exactly one component, excluding empty, '.', '..', '/' and NUL.
 * Symlinks are followed by the caller. Buffers belong to the caller, never to
 * guest memory. A zero-byte write does not extend a file; EOF reads return zero.
 */
export interface Storage {
  readonly root: Inode;
  lookup(parent: Inode, name: string): Inode;
  stat(inode: Inode): Stat;
  readlink(inode: Inode): string;
  /** Lists children without '.' or '..'. */
  readdir(inode: Inode): DirectoryEntry[];
  /** Pins an inode across unlink until the matching release. */
  retain(inode: Inode): void;
  release(inode: Inode): void;
  readInto(inode: Inode, offset: bigint, target: Uint8Array): number;
  write(inode: Inode, offset: bigint, source: Uint8Array): number;
  append(
    inode: Inode,
    source: Uint8Array
  ): { offset: bigint; bytesWritten: number };
  truncate(inode: Inode, size: bigint): void;
  setTimes(inode: Inode, times: Times): void;
  /** Confirms local storage commit, not replication or a Drive checkpoint. */
  sync(inode: Inode, dataOnly: boolean): void;
  /**
   * Returns a retained inode. Nonexclusive creation may open an existing file;
   * an existing directory fails with EISDIR, a symlink with ELOOP. A target is
   * required exactly when creating a symlink. Creation never truncates a file.
   */
  create(parent: Inode, name: string, options: CreateOptions): Inode;
  /** Directory hard links are forbidden. */
  link(inode: Inode, parent: Inode, name: string): void;
  unlink(parent: Inode, name: string, options: { directory: boolean }): void;
  rename(
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string
  ): void;
}

/** Identical operations with explicit asynchronous completion. */
export type AsyncStorage = {
  readonly [K in keyof Storage]: Storage[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<R>
    : Storage[K];
};

/** A root capability installed at an absolute guest path. */
export interface Mount<S = Storage> {
  path: string;
  storage: S;
  root?: Inode;
  readOnly?: boolean;
}

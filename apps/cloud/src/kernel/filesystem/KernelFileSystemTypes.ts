import type { Inode, Stat } from "../storage.ts";
import type { PosixMetadata } from "../PosixStorage.ts";

export type KernelStat = Omit<Stat, "type"> & {
  type: Stat["type"] | "character";
  ino: Inode;
  dev: bigint;
  readonly posix?: PosixMetadata;
};

export interface KernelPosixCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly euid: number;
  readonly egid: number;
  readonly groups?: readonly number[];
}

export interface KernelPosixOptions {
  readonly credentials: KernelPosixCredentials;
  readonly umask: number;
}

export type KernelPosixMetadata = PosixMetadata;

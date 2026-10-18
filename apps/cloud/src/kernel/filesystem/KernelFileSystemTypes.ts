import type { Inode, Stat } from "../storage.ts";

export type KernelStat = Omit<Stat, "type"> & {
  type: Stat["type"] | "character";
  ino: Inode;
  dev: bigint;
};

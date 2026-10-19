/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { fsOperation, leaf, runSync, type FsOperation } from "./operations.ts";
import {
  nodeStats,
  type BigIntStats,
  type KernelStat,
  type NodeStats,
  type NodeStatsLike,
} from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

export interface StatOptions {
  bigint?: boolean;
}

type StatsSyscall = "stat" | "lstat" | "fstat";

function* statsOperation(
  syscall: StatsSyscall,
  path: string | undefined,
  readStat: () => KernelStat,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  return nodeStats(yield* fsOperation(syscall, path, leaf(readStat)), options?.bigint);
}

export function* statOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  const name = pathString(path);
  return yield* statsOperation("stat", name, () => kernelFs.stat(name), options);
}

export function* lstatOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  const name = pathString(path);
  return yield* statsOperation("lstat", name, () => kernelFs.lstat(name), options);
}

export function* fstatOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  return yield* statsOperation("fstat", undefined, () => kernelFs.fstat(fd), options);
}

export function statSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options: { bigint: true },
): BigIntStats;
export function statSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: { bigint?: false },
): NodeStats;
export function statSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike;
export function statSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(statOperation(kernelFs, path, options));
}

export function lstatSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options: { bigint: true },
): BigIntStats;
export function lstatSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: { bigint?: false },
): NodeStats;
export function lstatSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike;
export function lstatSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(lstatOperation(kernelFs, path, options));
}

export function fstatSync(
  kernelFs: KernelFileSystem,
  fd: number,
  options: { bigint: true },
): BigIntStats;
export function fstatSync(
  kernelFs: KernelFileSystem,
  fd: number,
  options?: { bigint?: false },
): NodeStats;
export function fstatSync(
  kernelFs: KernelFileSystem,
  fd: number,
  options?: StatOptions,
): NodeStatsLike;
export function fstatSync(
  kernelFs: KernelFileSystem,
  fd: number,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(fstatOperation(kernelFs, fd, options));
}

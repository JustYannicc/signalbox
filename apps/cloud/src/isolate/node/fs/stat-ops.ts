/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import { fsOperation, fileLeaf, runSync, type FsOperation } from "./operations.ts";
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
  readStat: FsOperation<KernelStat>,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  return nodeStats(yield* fsOperation(syscall, path, readStat), options?.bigint);
}

export function* statOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  const name = pathString(path);
  return yield* statsOperation("stat", name, fileLeaf(kernelFs, "stat", [name]), options);
}

export function* lstatOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  const name = pathString(path);
  return yield* statsOperation("lstat", name, fileLeaf(kernelFs, "lstat", [name]), options);
}

export function* fstatOperation(
  kernelFs: NodeFsBackend,
  fd: number,
  options?: StatOptions,
): FsOperation<NodeStatsLike> {
  return yield* statsOperation("fstat", undefined, fileLeaf(kernelFs, "fstat", [fd]), options);
}

export function statSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options: { bigint: true },
): BigIntStats;
export function statSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: { bigint?: false },
): NodeStats;
export function statSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike;
export function statSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(statOperation(kernelFs, path, options));
}

export function lstatSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options: { bigint: true },
): BigIntStats;
export function lstatSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: { bigint?: false },
): NodeStats;
export function lstatSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike;
export function lstatSync(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(lstatOperation(kernelFs, path, options));
}

export function fstatSync(
  kernelFs: NodeFsBackend,
  fd: number,
  options: { bigint: true },
): BigIntStats;
export function fstatSync(
  kernelFs: NodeFsBackend,
  fd: number,
  options?: { bigint?: false },
): NodeStats;
export function fstatSync(
  kernelFs: NodeFsBackend,
  fd: number,
  options?: StatOptions,
): NodeStatsLike;
export function fstatSync(
  kernelFs: NodeFsBackend,
  fd: number,
  options?: StatOptions,
): NodeStatsLike {
  return runSync(fstatOperation(kernelFs, fd, options));
}

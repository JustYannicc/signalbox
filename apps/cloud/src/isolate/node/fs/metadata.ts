/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - These Node types define fs.Stats and fs.Dirent compatibility.
// @effect-diagnostics globalDate:off - Node fs Stats exposes Date fields derived from filesystem nanoseconds.
import * as NodeBuffer from "node:buffer";
import type * as NodeFS from "node:fs";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";

export type BigIntStats = NodeFS.BigIntStats;
export type NodeStats = NodeFS.Stats;

export type KernelStat = ReturnType<KernelFileSystem["stat"]>;
export interface KernelDirectoryEntry {
  readonly name: string;
  readonly type: KernelStat["type"];
}
export type NodeStatsLike = NodeFS.Stats | NodeFS.BigIntStats;
export type NodeDirentLike = NodeFS.Dirent<string> | NodeFS.Dirent<NodeBuffer.Buffer>;

export function encodedPath(
  value: string,
  encoding: BufferEncoding | "buffer" = "utf8",
): string | NodeBuffer.Buffer {
  const bytes = NodeBuffer.Buffer.from(value, "utf8");
  return encoding === "buffer" ? bytes : bytes.toString(encoding);
}

const modeByType: Readonly<Record<KernelStat["type"], number>> = {
  file: 0o100000,
  directory: 0o040000,
  symlink: 0o120000,
  character: 0o020000,
};

/**
 * The kernel stat supplies inode type and timestamps. POSIX storage supplies mode and ownership.
 * Missing POSIX metadata keeps type-only mode bits and -1 owner/block sentinels.
 */
class NodeFsStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number | bigint;
  readonly nlink: number | bigint;
  readonly uid: number | bigint;
  readonly gid: number | bigint;
  readonly rdev: number | bigint;
  readonly size: number | bigint;
  readonly blksize: number | bigint;
  readonly blocks: number | bigint;
  readonly atimeMs: number | bigint;
  readonly mtimeMs: number | bigint;
  readonly ctimeMs: number | bigint;
  readonly birthtimeMs: number | bigint;
  readonly atimeNs: bigint | undefined;
  readonly mtimeNs: bigint | undefined;
  readonly ctimeNs: bigint | undefined;
  readonly birthtimeNs: bigint | undefined;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;
  readonly #type: KernelStat["type"];

  constructor(stat: KernelStat, bigint: boolean) {
    const posix = stat.posix;
    this.#type = stat.type;
    this.dev = convert(stat.dev, bigint);
    this.ino = convert(stat.ino, bigint);
    this.mode = convert(BigInt(modeByType[stat.type] | (posix?.mode ?? 0)), bigint);
    this.nlink = convert(stat.nlink, bigint);
    this.uid = convert(BigInt(posix?.uid ?? -1), bigint);
    this.gid = convert(BigInt(posix?.gid ?? -1), bigint);
    this.rdev = bigint ? -1n : -1;
    this.size = convert(stat.size, bigint);
    this.blksize = bigint ? -1n : Number.NaN;
    this.blocks = bigint ? -1n : Number.NaN;
    this.atimeMs = timeMs(stat.atimeNs, bigint);
    this.mtimeMs = timeMs(stat.mtimeNs, bigint);
    this.ctimeMs = timeMs(stat.ctimeNs, bigint);
    this.birthtimeMs = bigint ? -1n : Number.NaN;
    this.atimeNs = bigint ? stat.atimeNs : undefined;
    this.mtimeNs = bigint ? stat.mtimeNs : undefined;
    this.ctimeNs = bigint ? stat.ctimeNs : undefined;
    this.birthtimeNs = bigint ? -1n : undefined;
    this.atime = dateFromNs(stat.atimeNs);
    this.mtime = dateFromNs(stat.mtimeNs);
    this.ctime = dateFromNs(stat.ctimeNs);
    this.birthtime = new Date(Number.NaN);
  }

  isFile() {
    return this.#type === "file";
  }
  isDirectory() {
    return this.#type === "directory";
  }
  isSymbolicLink() {
    return this.#type === "symlink";
  }
  isCharacterDevice() {
    return this.#type === "character";
  }
  isBlockDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

function convert(value: bigint, asBigInt: boolean): number | bigint {
  return asBigInt ? value : Number(value);
}

function timeMs(value: bigint, asBigInt: boolean): number | bigint {
  return asBigInt ? value / 1_000_000n : Number(value) / 1_000_000;
}

function dateFromNs(value: bigint): Date {
  return new Date(Number(value) / 1_000_000);
}

export function nodeStats(stat: KernelStat, bigint: true): NodeFS.BigIntStats;
export function nodeStats(stat: KernelStat, bigint?: false): NodeFS.Stats;
export function nodeStats(stat: KernelStat, bigint?: boolean): NodeStatsLike;
export function nodeStats(stat: KernelStat, bigint = false): NodeStatsLike {
  return new NodeFsStats(stat, bigint) as unknown as NodeStatsLike;
}

export class NodeFsDirent {
  readonly name: string | NodeBuffer.Buffer;
  readonly parentPath: string | NodeBuffer.Buffer;
  /** Deprecated Node alias. */
  readonly path: string | NodeBuffer.Buffer;
  readonly #type: KernelDirectoryEntry["type"];

  constructor(
    entry: KernelDirectoryEntry,
    parentPath: string,
    encoding: BufferEncoding | "buffer",
  ) {
    this.name = encodedPath(entry.name, encoding);
    this.parentPath = encodedPath(parentPath, encoding);
    this.path = this.parentPath;
    this.#type = entry.type;
  }

  isFile() {
    return this.#type === "file";
  }
  isDirectory() {
    return this.#type === "directory";
  }
  isSymbolicLink() {
    return this.#type === "symlink";
  }
  isCharacterDevice() {
    return this.#type === "character";
  }
  isBlockDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

export function nodeDirent(
  entry: KernelDirectoryEntry,
  parentPath: string,
  encoding: BufferEncoding | "buffer" = "utf8",
): NodeDirentLike {
  return new NodeFsDirent(entry, parentPath, encoding) as unknown as NodeDirentLike;
}

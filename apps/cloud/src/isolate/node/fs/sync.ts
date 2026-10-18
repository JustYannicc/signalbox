/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { callFs, unsupportedFs } from "./errors.ts";
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "./files.ts";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "./directories.ts";
import { ioOptions, readSync, writeBufferSync, writeStringSync, type IoOptions } from "./fd-ops.ts";
import { closeFd, openFd } from "./io.ts";
import {
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  realpathSync,
  readlinkSync,
  statSync,
  truncateSync,
  utimesSync,
  type StatOptions,
} from "./metadata-ops.ts";
import { pathString, type PathLike, type PathOrFd } from "./path.ts";
import { createReadStream, createWriteStream } from "./streams.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import type { BigIntStats, NodeStats, NodeStatsLike } from "./metadata.ts";

export function openSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  flags: string | number = "r",
  mode?: number,
): number {
  return openFd(kernelFs, pathString(path), parseOpenFlags(flags), normalizeMode(mode));
}

export function closeSync(kernelFs: KernelFileSystem, fd: number): void {
  closeFd(kernelFs, fd);
}

export function readSyncOverload(
  kernelFs: KernelFileSystem,
  fd: number,
  buffer: ArrayBufferView,
  offsetOrOptions: number | IoOptions = 0,
  length?: number,
  position?: number | null,
): number {
  return readSync(kernelFs, fd, buffer, offsetOrOptions, length, position);
}

export function writeSyncOverload(
  kernelFs: KernelFileSystem,
  fd: number,
  data: string | ArrayBufferView,
  offsetOrPosition?: number | null | IoOptions,
  lengthOrEncoding?: number | BufferEncoding,
  position?: number | null,
): number {
  if (typeof data === "string") {
    const at =
      typeof offsetOrPosition === "number" || offsetOrPosition === null
        ? offsetOrPosition
        : undefined;
    const encoding = typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
    return writeStringSync(kernelFs, fd, data, at, encoding);
  }
  const options =
    typeof offsetOrPosition === "object" && offsetOrPosition !== null
      ? offsetOrPosition
      : ioOptions(
          typeof offsetOrPosition === "number" ? offsetOrPosition : 0,
          typeof lengthOrEncoding === "number" ? lengthOrEncoding : undefined,
          position,
        );
  return writeBufferSync(kernelFs, fd, data, options);
}

export function accessSync(kernelFs: KernelFileSystem, path: PathLike, mode = 0): void {
  const name = pathString(path);
  if (mode !== 0) throw unsupportedFs("access", name);
  callFs("access", name, () => kernelFs.stat(name));
}

export function existsSync(kernelFs: KernelFileSystem, path: PathLike): boolean {
  try {
    kernelFs.stat(pathString(path));
    return true;
  } catch {
    return false;
  }
}

export function chmodSync(path: PathLike, _mode: number): never {
  throw unsupportedFs("chmod", pathString(path));
}

export function fchmodSync(_fd: number, _mode: number): never {
  throw unsupportedFs("fchmod");
}

export function statfsSync(path: PathLike): never {
  throw unsupportedFs("statfs", pathString(path));
}

export function fchownUnsupported(_fd: number, _uid: number, _gid: number): never {
  throw unsupportedFs("fchown");
}

export function createSyncApi(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  function statApi(path: PathLike, options: { bigint: true }): BigIntStats;
  function statApi(path: PathLike, options?: { bigint?: false }): NodeStats;
  function statApi(path: PathLike, options?: StatOptions): NodeStatsLike;
  function statApi(path: PathLike, options?: StatOptions): NodeStatsLike {
    return statSync(kernelFs, path, options);
  }

  function lstatApi(path: PathLike, options: { bigint: true }): BigIntStats;
  function lstatApi(path: PathLike, options?: { bigint?: false }): NodeStats;
  function lstatApi(path: PathLike, options?: StatOptions): NodeStatsLike;
  function lstatApi(path: PathLike, options?: StatOptions): NodeStatsLike {
    return lstatSync(kernelFs, path, options);
  }

  function fstatApi(fd: number, options: { bigint: true }): BigIntStats;
  function fstatApi(fd: number, options?: { bigint?: false }): NodeStats;
  function fstatApi(fd: number, options?: StatOptions): NodeStatsLike;
  function fstatApi(fd: number, options?: StatOptions): NodeStatsLike {
    return fstatSync(kernelFs, fd, options);
  }

  return {
    openSync: (path: PathLike, flags: string | number = "r", mode?: number) =>
      openSync(kernelFs, path, flags, mode),
    closeSync: (fd: number) => closeSync(kernelFs, fd),
    readSync: (
      fd: number,
      buffer: ArrayBufferView,
      offsetOrOptions?: number | IoOptions,
      length?: number,
      position?: number | null,
    ) => readSyncOverload(kernelFs, fd, buffer, offsetOrOptions, length, position),
    writeSync: (
      fd: number,
      data: string | ArrayBufferView,
      offsetOrPosition?: number | null | IoOptions,
      lengthOrEncoding?: number | BufferEncoding,
      position?: number | null,
    ) => writeSyncOverload(kernelFs, fd, data, offsetOrPosition, lengthOrEncoding, position),
    readFileSync: (path: PathOrFd, options?: BufferEncoding | Parameters<typeof readFileSync>[2]) =>
      readFileSync(kernelFs, path, options),
    writeFileSync: (
      path: PathOrFd,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof writeFileSync>[3],
    ) => writeFileSync(kernelFs, path, data, options),
    appendFileSync: (
      path: PathOrFd,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof appendFileSync>[3],
    ) => appendFileSync(kernelFs, path, data, options),
    fstatSync: fstatApi,
    statSync: statApi,
    lstatSync: lstatApi,
    readdirSync: (path: PathLike, options?: BufferEncoding | Parameters<typeof readdirSync>[2]) =>
      readdirSync(kernelFs, path, options),
    readlinkSync: (path: PathLike, options?: BufferEncoding | Parameters<typeof readlinkSync>[2]) =>
      readlinkSync(kernelFs, path, options),
    realpathSync: (path: PathLike, options?: BufferEncoding | Parameters<typeof realpathSync>[2]) =>
      realpathSync(kernelFs, path, options),
    renameSync: (oldPath: PathLike, newPath: PathLike) => renameSync(kernelFs, oldPath, newPath),
    mkdirSync: (path: PathLike, options?: number | Parameters<typeof mkdirSync>[2]) =>
      mkdirSync(kernelFs, path, options),
    mkdtempSync: (prefix: PathLike, options?: BufferEncoding | Parameters<typeof mkdtempSync>[2]) =>
      mkdtempSync(kernelFs, prefix, options),
    rmSync: (path: PathLike, options?: Parameters<typeof rmSync>[2]) =>
      rmSync(kernelFs, path, options),
    rmdirSync: (path: PathLike) => rmdirSync(kernelFs, path),
    unlinkSync: (path: PathLike) => unlinkSync(kernelFs, path),
    linkSync: (source: PathLike, destination: PathLike) => linkSync(kernelFs, source, destination),
    symlinkSync: (target: PathLike, path: PathLike, type?: string) =>
      symlinkSync(kernelFs, target, path, type),
    copyFileSync: (source: PathLike, destination: PathLike, flags?: number) =>
      copyFileSync(kernelFs, pathString(source), pathString(destination), flags),
    truncateSync: (path: PathLike | number, length?: number) =>
      truncateSync(kernelFs, path, length),
    ftruncateSync: (fd: number, length?: number) => ftruncateSync(kernelFs, fd, length),
    fsyncSync: (fd: number) => fsyncSync(kernelFs, fd),
    utimesSync: (
      path: PathLike,
      atime: Parameters<typeof utimesSync>[2],
      mtime: Parameters<typeof utimesSync>[3],
    ) => utimesSync(kernelFs, path, atime, mtime),
    accessSync: (path: PathLike, mode?: number) => accessSync(kernelFs, path, mode),
    existsSync: (path: PathLike) => existsSync(kernelFs, path),
    chmodSync,
    fchmodSync,
    fchownSync: fchownUnsupported,
    statfsSync: (path: PathLike) => statfsSync(path),
    createReadStream: (
      path: PathLike | undefined,
      options?: Parameters<typeof createReadStream>[2],
    ) => createReadStream(kernelFs, path, options, runLeaf),
    createWriteStream: (
      path: PathLike | undefined,
      options?: Parameters<typeof createWriteStream>[2],
    ) => createWriteStream(kernelFs, path, options, runLeaf),
  };
}

/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics globalDate:off - Node fs utimes accepts the literal "now" synchronously.
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { callFs } from "./errors.ts";
import {
  encodedPath,
  nodeStats,
  type BigIntStats,
  type NodeStats,
  type NodeStatsLike,
} from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

export type TimeLike = Date | number | string;
export interface StatOptions {
  bigint?: boolean;
}

type StatResult = NodeStats | BigIntStats;

function timeNs(value: TimeLike): bigint {
  const milliseconds =
    value === "now" ? Date.now() : value instanceof Date ? value.getTime() : Number(value) * 1000;
  if (!Number.isFinite(milliseconds)) {
    throw Object.assign(
      new TypeError("The time value must be a finite number, date, or numeric string"),
      {
        code: "ERR_INVALID_ARG_VALUE",
      },
    );
  }
  const nanoseconds = milliseconds * 1_000_000;
  if (!Number.isFinite(nanoseconds)) {
    throw Object.assign(new RangeError("The time value is out of range"), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return BigInt(Math.trunc(nanoseconds));
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
): StatResult;
export function statSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  const name = pathString(path);
  return nodeStats(
    callFs("stat", name, () => kernelFs.stat(name)),
    options?.bigint,
  );
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
): StatResult;
export function lstatSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: StatOptions,
): NodeStatsLike {
  const name = pathString(path);
  return nodeStats(
    callFs("lstat", name, () => kernelFs.lstat(name)),
    options?.bigint,
  );
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
): StatResult;
export function fstatSync(
  kernelFs: KernelFileSystem,
  fd: number,
  options?: StatOptions,
): NodeStatsLike {
  return nodeStats(
    callFs("fstat", undefined, () => kernelFs.fstat(fd)),
    options?.bigint,
  );
}

export function realpathSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" | null } | null,
): string | NodeBuffer.Buffer {
  const name = pathString(path);
  const result = callFs("realpath", name, () => kernelFs.realpath(name));
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encodedPath(result, encoding ?? "utf8");
}

export function readlinkSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" | null } | null,
): string | NodeBuffer.Buffer {
  const name = pathString(path);
  const result = callFs("readlink", name, () => kernelFs.readlink(name));
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encodedPath(result, encoding ?? "utf8");
}

export function utimesSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  atime: TimeLike,
  mtime: TimeLike,
  follow = true,
): void {
  const name = pathString(path);
  const times = { atimeNs: timeNs(atime), mtimeNs: timeNs(mtime) };
  callFs("utimes", name, () => kernelFs.setTimes(name, times, follow));
}

export function futimesSync(
  kernelFs: KernelFileSystem,
  fd: number,
  atime: TimeLike,
  mtime: TimeLike,
): void {
  const times = { atimeNs: timeNs(atime), mtimeNs: timeNs(mtime) };
  callFs("futimes", undefined, () => kernelFs.fsetTimes(fd, times));
}

export function truncateSync(
  kernelFs: KernelFileSystem,
  path: PathLike | number,
  length = 0,
): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw Object.assign(new RangeError('The "len" argument must be a non-negative safe integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  if (typeof path === "number") {
    ftruncateSync(kernelFs, path, length);
    return;
  }
  const name = pathString(path);
  callFs("truncate", name, () => kernelFs.truncate(name, BigInt(length)));
}

export function ftruncateSync(kernelFs: KernelFileSystem, fd: number, length = 0): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw Object.assign(new RangeError('The "len" argument must be a non-negative safe integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  callFs("ftruncate", undefined, () => kernelFs.ftruncate(fd, BigInt(length)));
}

export function fsyncSync(kernelFs: KernelFileSystem, fd: number, dataOnly = false): void {
  callFs(dataOnly ? "fdatasync" : "fsync", undefined, () => kernelFs.sync(fd, dataOnly));
}

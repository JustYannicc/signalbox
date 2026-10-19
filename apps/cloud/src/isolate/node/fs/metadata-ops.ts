/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics globalDate:off - Node fs utimes accepts the literal "now" synchronously.
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { fsOperation, leaf, runSync, type FsOperation } from "./operations.ts";
import { encodedPath } from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

export type TimeLike = Date | number | string;

export {
  fstatOperation,
  fstatSync,
  lstatOperation,
  lstatSync,
  statOperation,
  statSync,
} from "./stat-ops.ts";
export type { StatOptions } from "./stat-ops.ts";

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

export function* realpathOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" | null } | null,
): FsOperation<string | NodeBuffer.Buffer> {
  const name = pathString(path);
  const result = yield* fsOperation(
    "realpath",
    name,
    leaf(() => kernelFs.realpath(name)),
  );
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encodedPath(result, encoding ?? "utf8");
}

export function* readlinkOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" | null } | null,
): FsOperation<string | NodeBuffer.Buffer> {
  const name = pathString(path);
  const result = yield* fsOperation(
    "readlink",
    name,
    leaf(() => kernelFs.readlink(name)),
  );
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encodedPath(result, encoding ?? "utf8");
}

export function* utimesOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  atime: TimeLike,
  mtime: TimeLike,
  follow = true,
): FsOperation<void> {
  const name = pathString(path);
  const times = { atimeNs: timeNs(atime), mtimeNs: timeNs(mtime) };
  yield* fsOperation(
    "utimes",
    name,
    leaf(() => kernelFs.setTimes(name, times, follow)),
  );
}

export function* futimesOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  atime: TimeLike,
  mtime: TimeLike,
): FsOperation<void> {
  const times = { atimeNs: timeNs(atime), mtimeNs: timeNs(mtime) };
  yield* fsOperation(
    "futimes",
    undefined,
    leaf(() => kernelFs.fsetTimes(fd, times)),
  );
}

export function* truncateOperation(
  kernelFs: KernelFileSystem,
  path: PathLike | number,
  length = 0,
): FsOperation<void> {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw Object.assign(new RangeError('The "len" argument must be a non-negative safe integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  if (typeof path === "number") {
    yield* ftruncateOperation(kernelFs, path, length);
    return;
  }
  const name = pathString(path);
  yield* fsOperation(
    "truncate",
    name,
    leaf(() => kernelFs.truncate(name, BigInt(length))),
  );
}

export function* ftruncateOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  length = 0,
): FsOperation<void> {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw Object.assign(new RangeError('The "len" argument must be a non-negative safe integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  yield* fsOperation(
    "ftruncate",
    undefined,
    leaf(() => kernelFs.ftruncate(fd, BigInt(length))),
  );
}

export function* fsyncOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  dataOnly = false,
): FsOperation<void> {
  yield* fsOperation(
    dataOnly ? "fdatasync" : "fsync",
    undefined,
    leaf(() => kernelFs.sync(fd, dataOnly)),
  );
}

export const realpathSync = (...args: Parameters<typeof realpathOperation>) =>
  runSync(realpathOperation(...args));

export const readlinkSync = (...args: Parameters<typeof readlinkOperation>) =>
  runSync(readlinkOperation(...args));

export const utimesSync = (...args: Parameters<typeof utimesOperation>) =>
  runSync(utimesOperation(...args));

export const futimesSync = (...args: Parameters<typeof futimesOperation>) =>
  runSync(futimesOperation(...args));

export const truncateSync = (...args: Parameters<typeof truncateOperation>) =>
  runSync(truncateOperation(...args));

export const ftruncateSync = (...args: Parameters<typeof ftruncateOperation>) =>
  runSync(ftruncateOperation(...args));

export const fsyncSync = (...args: Parameters<typeof fsyncOperation>) =>
  runSync(fsyncOperation(...args));

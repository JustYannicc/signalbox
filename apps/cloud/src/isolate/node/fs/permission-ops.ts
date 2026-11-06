import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import { fsOperation, type FsOperation, fileLeaf } from "./operations.ts";
import { pathString, type PathLike } from "./path.ts";

export function* accessOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  mode = 0,
): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation("access", name, fileLeaf(kernelFs, "access", [name, mode]));
}

export function* chmodOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  mode: number | string,
): FsOperation<void> {
  const name = pathString(path);
  const permissions = parsePermissionMode(mode);
  yield* fsOperation("chmod", name, fileLeaf(kernelFs, "chmod", [name, permissions]));
}

export function* fchmodOperation(
  kernelFs: NodeFsBackend,
  fd: number,
  mode: number | string,
): FsOperation<void> {
  const permissions = parsePermissionMode(mode);
  yield* fsOperation("fchmod", undefined, fileLeaf(kernelFs, "fchmod", [fd, permissions]));
}

export function* chownOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  uid: number,
  gid: number,
): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation("chown", name, fileLeaf(kernelFs, "chown", [name, uid, gid]));
}

export function* fchownOperation(
  kernelFs: NodeFsBackend,
  fd: number,
  uid: number,
  gid: number,
): FsOperation<void> {
  yield* fsOperation("fchown", undefined, fileLeaf(kernelFs, "fchown", [fd, uid, gid]));
}

export function parsePermissionMode(mode: number | string): number {
  let value = mode;
  if (typeof value === "string") {
    if (!/^[0-7]+$/.test(value)) {
      throw Object.assign(new TypeError('The "mode" argument must be an octal string or integer'), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    value = Number.parseInt(value, 8);
  }
  if (typeof value !== "number") {
    throw Object.assign(new TypeError('The "mode" argument must be a number or string'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw Object.assign(new RangeError('The "mode" argument must be an unsigned 32-bit integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  // Node accepts Stats.mode, including inode type bits; the kernel accepts permissions only.
  return value & 0o7777;
}

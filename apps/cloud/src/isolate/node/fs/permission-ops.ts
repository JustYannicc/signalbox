import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { fsOperation, leaf, type FsOperation } from "./operations.ts";
import { pathString, type PathLike } from "./path.ts";

export function* accessOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  mode = 0,
): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation(
    "access",
    name,
    leaf(() => kernelFs.access(name, mode)),
  );
}

export function* chmodOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  mode: number | string,
): FsOperation<void> {
  const name = pathString(path);
  const permissions = parsePermissionMode(mode);
  yield* fsOperation(
    "chmod",
    name,
    leaf(() => kernelFs.chmod(name, permissions)),
  );
}

export function* fchmodOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  mode: number | string,
): FsOperation<void> {
  const permissions = parsePermissionMode(mode);
  yield* fsOperation(
    "fchmod",
    undefined,
    leaf(() => kernelFs.fchmod(fd, permissions)),
  );
}

export function* chownOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  uid: number,
  gid: number,
): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation(
    "chown",
    name,
    leaf(() => kernelFs.chown(name, uid, gid)),
  );
}

export function* fchownOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  uid: number,
  gid: number,
): FsOperation<void> {
  yield* fsOperation(
    "fchown",
    undefined,
    leaf(() => kernelFs.fchown(fd, uid, gid)),
  );
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

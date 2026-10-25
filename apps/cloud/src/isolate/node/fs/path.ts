/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeURL from "node:url";

export type PathLike = string | NodeBuffer.Buffer | URL;
export type PathOrFd = PathLike | number;

export function pathString(path: PathLike): string {
  if (typeof path === "string") return path;
  if (path instanceof URL) return NodeURL.fileURLToPath(path);
  if (NodeBuffer.Buffer.isBuffer(path)) {
    const decoded = path.toString("utf8");
    if (!NodeBuffer.Buffer.from(decoded, "utf8").equals(path)) {
      const error = new TypeError("The filesystem host only supports UTF-8 path bytes");
      Object.assign(error, { code: "ENOTSUP" });
      throw error;
    }
    return decoded;
  }
  throw Object.assign(new TypeError("The path argument must be a string, Buffer, or file URL"), {
    code: "ERR_INVALID_ARG_TYPE",
  });
}

export function pathOrFd(value: PathOrFd): string | number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw Object.assign(new TypeError("The file descriptor must be a non-negative integer"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    return value;
  }
  return pathString(value);
}

export function finitePosition(position: number | null | undefined): bigint | null {
  if (position === undefined || position === null) return null;
  if (!Number.isSafeInteger(position) || position < 0) {
    throw Object.assign(
      new RangeError('The "position" argument must be a non-negative safe integer'),
      {
        code: "ERR_OUT_OF_RANGE",
      },
    );
  }
  return BigInt(position);
}

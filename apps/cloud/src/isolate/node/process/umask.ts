import type { NodeProcessFileSystem } from "./context.ts";
import { unsupportedNodeOperation } from "./NodeError.ts";

export function processUmask(filesystem: NodeProcessFileSystem, mask?: number | string): number {
  const policy = filesystem.posixPolicy;
  if (!policy || !filesystem.setUmask) return unsupportedNodeOperation("process.umask");
  if (mask === undefined) return policy.umask;
  let value = mask;
  if (typeof value === "string") {
    if (!/^[0-7]+$/.test(value))
      throw Object.assign(new TypeError('The "mask" argument must be an octal string'), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    value = Number.parseInt(value, 8);
  }
  if (typeof value !== "number")
    throw Object.assign(new TypeError('The "mask" argument must be a number or string'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw Object.assign(new RangeError('The "mask" argument must be an unsigned 32-bit integer'), {
      code: "ERR_OUT_OF_RANGE",
    });
  return filesystem.setUmask(value & 0o777);
}

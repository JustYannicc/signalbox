// @effect-diagnostics nodeBuiltinImport:off - These are guest POSIX paths, independent of the host.
import * as NodePath from "node:path";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";

const pathOperands: Readonly<Record<string, readonly number[]>> = {
  path_open: [2],
  path_filestat_get: [2],
  path_filestat_set_times: [2],
  path_create_directory: [1],
  path_remove_directory: [1],
  path_unlink_file: [1],
  path_readlink: [1],
  path_symlink: [3],
  path_link: [2, 5],
  path_rename: [1, 4],
  stat_metadata: [1],
  access: [0],
  realpath: [0],
  chmod: [0],
  chown: [1],
};

/** Path-based syscalls must obey the same ownership rule as direct descriptor calls. */
export function hasPrivateDescriptorAlias(
  request: KernelSyscallRequest,
  allowed: (fd: number) => boolean,
) {
  for (const index of pathOperands[request.name] ?? []) {
    const pointer = Number(request.args[index]);
    const length = Number(request.args[index + 1]);
    if (
      !Number.isSafeInteger(pointer) ||
      pointer < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      continue;
    const region = request.regions.find(
      (item) => pointer >= item.pointer && pointer + length <= item.pointer + item.bytes.byteLength,
    );
    if (region === undefined) continue;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      region.bytes.subarray(pointer - region.pointer, pointer - region.pointer + length),
    );
    const path = NodePath.posix.resolve("/", raw);
    const match = /^\/(?:proc\/self\/fd|dev\/fd)\/(0|[1-9][0-9]*)(?:\/|$)/.exec(path);
    if (match !== null && !allowed(Number(match[1]))) return true;
  }
  return false;
}

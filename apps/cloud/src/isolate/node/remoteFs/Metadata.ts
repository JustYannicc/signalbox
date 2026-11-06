import type { KernelStat } from "../../../kernel/KernelFileSystem.ts";
import type { Times } from "../../../kernel/storage.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../../kernel/KernelSyscallPort.ts";
import { SyscallFrame } from "./Frame.ts";
import type { NodeFsSyscalls } from "./Calls.ts";

export function createRemoteFileMetadata(calls: NodeFsSyscalls, posix: boolean) {
  const stat = async (
    path: string | number,
    follow = true,
    signal?: AbortSignal,
  ): Promise<KernelStat> => {
    const frame = new SyscallFrame();
    const name = typeof path === "string" ? frame.path(path, true) : undefined;
    const output = frame.output(64);
    if (name === undefined)
      await calls.call(frame, "fd_filestat_get", [Number(path), output], signal);
    else
      await calls.call(
        frame,
        "path_filestat_get",
        [calls.root, follow ? 1 : 0, name.pointer, name.length, output],
        signal,
      );
    const record = new DataView(frame.bytes(output, 64).buffer);
    const kinds: Readonly<Record<number, KernelStat["type"]>> = {
      2: "character",
      3: "directory",
      4: "file",
      7: "symlink",
    };
    const type = kinds[record.getUint8(16)];
    if (type === undefined) throw new Error("Computer returned an unsupported Node file type");
    let metadata: KernelStat["posix"];
    if (posix) {
      const extra = new SyscallFrame();
      const source = typeof path === "string" ? extra.path(path) : undefined;
      const result = extra.output(12);
      await calls.call(
        extra,
        "stat_metadata",
        [
          typeof path === "number" ? path : calls.root,
          source?.pointer ?? 0,
          source?.length ?? 0,
          follow ? 1 : 0,
          result,
        ],
        signal,
      );
      const fields = new DataView(extra.bytes(result, 12).buffer);
      metadata = {
        mode: fields.getUint32(0, true) & 0o7777,
        uid: fields.getUint32(4, true),
        gid: fields.getUint32(8, true),
      };
    }
    return {
      type,
      dev: record.getBigUint64(0, true),
      ino: record.getBigUint64(8, true),
      nlink: record.getBigUint64(24, true),
      size: record.getBigUint64(32, true),
      atimeNs: record.getBigUint64(40, true),
      mtimeNs: record.getBigUint64(48, true),
      ctimeNs: record.getBigUint64(56, true),
      ...(metadata === undefined ? {} : { posix: metadata }),
    };
  };
  const chmod = async (path: string, mode: number, _follow = true, signal?: AbortSignal) => {
    const frame = new SyscallFrame();
    const name = frame.path(path);
    await calls.call(frame, "chmod", [name.pointer, name.length, mode], signal);
  };
  const chown = async (
    path: string | number,
    uid: number,
    gid: number,
    follow = true,
    signal?: AbortSignal,
  ) => {
    const frame = new SyscallFrame();
    const name = typeof path === "string" ? frame.path(path, true) : undefined;
    await calls.call(
      frame,
      "chown",
      [
        typeof path === "number" ? path : calls.root,
        name?.pointer ?? 0,
        name?.length ?? 0,
        uid,
        gid,
        follow ? 1 : 0,
      ],
      signal,
    );
  };
  const times = async (
    path: string | number,
    values: Times,
    follow = true,
    signal?: AbortSignal,
  ) => {
    const frame = new SyscallFrame();
    const name = typeof path === "string" ? frame.path(path, true) : undefined;
    const flags = (values.atimeNs === undefined ? 0 : 1) | (values.mtimeNs === undefined ? 0 : 4);
    if (name === undefined)
      await calls.call(
        frame,
        "fd_filestat_set_times",
        [Number(path), values.atimeNs ?? 0n, values.mtimeNs ?? 0n, flags],
        signal,
      );
    else
      await calls.call(
        frame,
        "path_filestat_set_times",
        [
          calls.root,
          follow ? 1 : 0,
          name.pointer,
          name.length,
          values.atimeNs ?? 0n,
          values.mtimeNs ?? 0n,
          flags,
        ],
        signal,
      );
  };
  return {
    stat: (path: string, signal?: AbortSignal) => stat(path, true, signal),
    lstat: (path: string, signal?: AbortSignal) => stat(path, false, signal),
    fstat: (fd: number, signal?: AbortSignal) => stat(fd, true, signal),
    chmod,
    async fchmod(fd: number, mode: number, signal?: AbortSignal) {
      await calls.call(new SyscallFrame(), "fchmod", [fd, mode], signal);
    },
    chown,
    fchown: (fd: number, uid: number, gid: number, signal?: AbortSignal) =>
      chown(fd, uid, gid, true, signal),
    setTimes: times,
    fsetTimes: (fd: number, values: Times, signal?: AbortSignal) => times(fd, values, true, signal),
    async access(path: string, mode: number, effectiveIds = false, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const name = frame.path(path);
      await calls.call(
        frame,
        "access",
        [name.pointer, name.length, mode, effectiveIds ? 1 : 0],
        signal,
      );
    },
    async realpath(path: string, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const name = frame.path(path);
      const output = frame.output(KERNEL_SYSCALL_MAX_IO_BYTES);
      const needed = frame.output(4);
      await calls.call(
        frame,
        "realpath",
        [name.pointer, name.length, output, KERNEL_SYSCALL_MAX_IO_BYTES, needed],
        signal,
      );
      const length = frame.u32(needed);
      return new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes(output, length));
    },
  };
}

import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../../kernel/KernelSyscallPort.ts";
import {
  KernelOpenFlags,
  parseOpenFlags,
  descriptorRights,
} from "../../../kernel/KernelOpenFlags.ts";
import type { KernelStat } from "../../../kernel/KernelFileSystem.ts";
import { SyscallFrame } from "./Frame.ts";
import type { NodeFsSyscalls } from "./Calls.ts";

export function createRemoteFileIo(
  calls: NodeFsSyscalls,
  type: (path: string, signal?: AbortSignal) => Promise<KernelStat["type"]>,
) {
  const open = async (path: string, flags: number, mode?: number, signal?: AbortSignal) => {
    const parsed = parseOpenFlags(flags);
    let fileType: KernelStat["type"] = "file";
    try {
      fileType = await type(path, signal);
    } catch (cause) {
      if (
        !(
          parsed.create &&
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
      )
        throw cause;
    }
    const rights = descriptorRights(parsed, fileType, false);
    const frame = new SyscallFrame();
    const name = frame.path(path, true);
    const output = frame.output(4);
    const oflags =
      (parsed.create ? 1 : 0) |
      (parsed.directory ? 2 : 0) |
      (parsed.exclusive ? 4 : 0) |
      (parsed.truncate ? 8 : 0);
    await calls.call(
      frame,
      "path_open",
      [
        calls.root,
        parsed.noFollow ? 0 : 1,
        name.pointer,
        name.length,
        oflags,
        rights.base,
        rights.inheriting,
        parsed.statusFlags,
        output,
      ],
      signal,
      mode,
      flags,
    );
    return frame.u32(output);
  };
  const close = async (fd: number, signal?: AbortSignal) => {
    await calls.call(new SyscallFrame(), "fd_close", [fd], signal);
  };
  const io = async (
    write: boolean,
    fd: number,
    bytes: Uint8Array,
    position: bigint | null,
    signal?: AbortSignal,
  ) => {
    const length = Math.min(bytes.byteLength, KERNEL_SYSCALL_MAX_IO_BYTES);
    const frame = new SyscallFrame();
    const data = write ? frame.input(bytes.subarray(0, length)) : frame.output(length);
    const vector = new Uint8Array(8);
    const view = new DataView(vector.buffer);
    view.setUint32(0, data, true);
    view.setUint32(4, length, true);
    const vectors = frame.input(vector);
    const output = frame.output(4);
    if (position === null)
      await calls.call(frame, write ? "fd_write" : "fd_read", [fd, vectors, 1, output], signal);
    else
      await calls.call(
        frame,
        write ? "fd_pwrite" : "fd_pread",
        [fd, vectors, 1, position, output],
        signal,
      );
    const count = frame.u32(output);
    if (count > length) throw new Error("Computer returned an invalid filesystem I/O count");
    if (!write) bytes.set(frame.bytes(data, count));
    return count;
  };
  const position = async (fd: number, signal?: AbortSignal) => {
    const frame = new SyscallFrame();
    const output = frame.output(8);
    await calls.call(frame, "fd_tell", [fd, output], signal);
    return frame.u64(output);
  };
  const seek = async (fd: number, offset: bigint, signal?: AbortSignal) => {
    const frame = new SyscallFrame();
    const output = frame.output(8);
    await calls.call(frame, "fd_seek", [fd, offset, 0, output], signal);
    return frame.u64(output);
  };
  const move = async (source: number, target: number, signal?: AbortSignal) => {
    await calls.call(new SyscallFrame(), "fd_renumber", [source, target], signal);
  };
  const truncateFd = async (fd: number, size: bigint, signal?: AbortSignal) => {
    await calls.call(new SyscallFrame(), "fd_filestat_set_size", [fd, size], signal);
  };
  return {
    open,
    close,
    position,
    seek,
    move,
    read: (fd: number, target: Uint8Array, offset: bigint | null, signal?: AbortSignal) =>
      io(false, fd, target, offset, signal),
    write: (fd: number, source: Uint8Array, offset: bigint | null, signal?: AbortSignal) =>
      io(true, fd, source, offset, signal),
    ftruncate: truncateFd,
    async truncate(path: string, size: bigint, signal?: AbortSignal) {
      const fd = await open(path, KernelOpenFlags.O_WRONLY, undefined, signal);
      try {
        await truncateFd(fd, size, signal);
      } finally {
        await close(fd);
      }
    },
    async sync(fd: number, dataOnly = false, signal?: AbortSignal) {
      await calls.call(new SyscallFrame(), dataOnly ? "fd_datasync" : "fd_sync", [fd], signal);
    },
  };
}

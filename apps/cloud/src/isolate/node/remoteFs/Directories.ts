import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../../kernel/KernelSyscallPort.ts";
import { KernelOpenFlags } from "../../../kernel/KernelOpenFlags.ts";
import { kernelError } from "../../../kernel/KernelErrno.ts";
import { SyscallFrame } from "./Frame.ts";
import type { NodeFsSyscalls } from "./Calls.ts";
import type { createRemoteFileIo } from "./Io.ts";

export function createRemoteDirectories(
  calls: NodeFsSyscalls,
  io: ReturnType<typeof createRemoteFileIo>,
) {
  const pathCall = async (
    operation: "path_create_directory" | "path_remove_directory" | "path_unlink_file",
    path: string,
    signal?: AbortSignal,
    mode?: number,
  ) => {
    const frame = new SyscallFrame();
    const name = frame.path(path, true);
    await calls.call(frame, operation, [calls.root, name.pointer, name.length], signal, mode);
  };
  return {
    mkdir: (path: string, mode?: number, signal?: AbortSignal) =>
      pathCall("path_create_directory", path, signal, mode),
    rmdir: (path: string, signal?: AbortSignal) => pathCall("path_remove_directory", path, signal),
    unlink: (path: string, signal?: AbortSignal) => pathCall("path_unlink_file", path, signal),
    async rename(source: string, destination: string, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const from = frame.path(source, true);
      const to = frame.path(destination, true);
      await calls.call(
        frame,
        "path_rename",
        [calls.root, from.pointer, from.length, calls.root, to.pointer, to.length],
        signal,
      );
    },
    async link(source: string, destination: string, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const from = frame.path(source, true);
      const to = frame.path(destination, true);
      await calls.call(
        frame,
        "path_link",
        [calls.root, 1, from.pointer, from.length, calls.root, to.pointer, to.length],
        signal,
      );
    },
    async symlink(target: string, path: string, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const to = frame.path(target);
      const name = frame.path(path, true);
      await calls.call(
        frame,
        "path_symlink",
        [to.pointer, to.length, calls.root, name.pointer, name.length],
        signal,
      );
    },
    async readlink(path: string, signal?: AbortSignal) {
      const frame = new SyscallFrame();
      const name = frame.path(path, true);
      const output = frame.output(KERNEL_SYSCALL_MAX_IO_BYTES);
      const count = frame.output(4);
      await calls.call(
        frame,
        "path_readlink",
        [calls.root, name.pointer, name.length, output, KERNEL_SYSCALL_MAX_IO_BYTES, count],
        signal,
      );
      const length = frame.u32(count);
      if (length === KERNEL_SYSCALL_MAX_IO_BYTES) throw kernelError("ENAMETOOLONG");
      return new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes(output, length));
    },
    async readdir(path: string, signal?: AbortSignal) {
      const fd = await io.open(
        path,
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
        undefined,
        signal,
      );
      try {
        let cookie = 0n;
        let capacity = 64 * 1024;
        const names: string[] = [];
        while (true) {
          const frame = new SyscallFrame();
          const output = frame.output(capacity);
          const count = frame.output(4);
          await calls.call(frame, "fd_readdir", [fd, output, capacity, cookie, count], signal);
          const length = frame.u32(count);
          const bytes = frame.bytes(output, length);
          let offset = 0;
          let next = cookie;
          while (offset + 24 <= bytes.byteLength) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 24);
            const size = view.getUint32(16, true);
            if (size > bytes.byteLength - offset - 24) break;
            const name = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(offset + 24, offset + 24 + size),
            );
            if (name !== "." && name !== "..") names.push(name);
            next = view.getBigUint64(0, true);
            offset += 24 + size;
          }
          if (length < capacity && offset === length) break;
          if (next === cookie) {
            if (capacity === KERNEL_SYSCALL_MAX_IO_BYTES) throw kernelError("ENAMETOOLONG");
            capacity = Math.min(capacity * 2, KERNEL_SYSCALL_MAX_IO_BYTES);
          } else cookie = next;
        }
        return names;
      } finally {
        await io.close(fd);
      }
    },
  };
}

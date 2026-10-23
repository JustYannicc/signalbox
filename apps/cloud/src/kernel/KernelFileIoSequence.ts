import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES, type KernelSyscallRequest } from "./KernelSyscallPort.ts";
import type { SyscallMemory } from "./syscall/SyscallMemory.ts";
import type { WasiDescriptor } from "./wasi/internal_wasi_descriptors.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";

interface Sequence {
  readonly name: string;
  readonly fd: number;
  readonly descriptor: WasiDescriptor;
  readonly owner: object;
  readonly release: () => void;
  offset: number;
  remaining: number;
}

/** Keeps one guest file operation exclusive even while its child is between RPCs. */
export class KernelFileIoSequence {
  readonly #filesystem: KernelFileSystem;
  #active: Sequence | undefined;

  constructor(filesystem: KernelFileSystem) {
    this.#filesystem = filesystem;
  }

  async begin(
    request: KernelSyscallRequest,
    args: readonly (number | bigint)[],
    memory: SyscallMemory,
    signal: AbortSignal,
  ) {
    const fd = Number(args[0]);
    const offset = request.transferOffset ?? 0;
    const active = this.#active;
    if (
      active !== undefined &&
      (active.name !== request.name || active.fd !== fd || active.offset !== offset)
    )
      this.release();
    if (!["fd_read", "fd_write", "fd_pread", "fd_pwrite"].includes(request.name)) return undefined;
    const descriptor = this.#filesystem.descriptors.get(fd);
    if (this.#active !== undefined && this.#active.descriptor !== descriptor) this.release();
    if (descriptor.kind !== "file") return undefined;
    if (this.#active !== undefined) {
      this.#active.remaining = memory
        .iovecs(Number(args[1]), Number(args[2]))
        .reduce((sum, vector) => sum + vector.length, 0);
      return this.#active.owner;
    }

    let remaining: number;
    try {
      remaining = memory
        .iovecs(Number(args[1]), Number(args[2]))
        .reduce((sum, vector) => sum + vector.length, 0);
    } catch {
      return undefined;
    }
    if (offset === 0 && remaining <= KERNEL_SYSCALL_MAX_IO_BYTES) return undefined;
    const owner = {};
    const write = request.name === "fd_write" || request.name === "fd_pwrite";
    const release = await runAsync(descriptor.acquireIo(owner, write, signal));
    this.#active = { name: request.name, fd, descriptor, owner, release, offset, remaining };
    return owner;
  }

  complete(request: KernelSyscallRequest, count: number, limit: number, success: boolean) {
    const active = this.#active;
    if (active === undefined) return;
    const read = active.name === "fd_read" || active.name === "fd_pread";
    if (
      request.transferOffset !== undefined &&
      success &&
      count > 0 &&
      count < active.remaining &&
      (!read || count === Math.min(limit, active.remaining))
    ) {
      active.offset += count;
    } else this.release();
  }

  release() {
    const active = this.#active;
    this.#active = undefined;
    active?.release();
  }
}

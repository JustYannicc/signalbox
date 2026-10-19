import type { KernelCoreutilsNamespace } from "./KernelCoreutilsPort.ts";
import { KERNEL_COREUTILS_MAX_TRANSFER_BYTES } from "./KernelCoreutilsPort.ts";
import type { WasiMemory } from "./wasi/internal_wasi_memory.ts";

export interface KernelCoreutilsSparsePointer {
  readonly argument: number;
  readonly length: number | { readonly argument: number };
  readonly output?: boolean;
  readonly maxBytes?: number;
}

const noMemory = [] as const;
const output = (argument: number, length: number): KernelCoreutilsSparsePointer => ({
  argument,
  length,
  output: true,
});
const path = (argument = 1, lengthArgument = 2): KernelCoreutilsSparsePointer => ({
  argument,
  length: { argument: lengthArgument },
  maxBytes: KERNEL_COREUTILS_MAX_TRANSFER_BYTES - 24,
});

/** One ABI map drives both the child range planner and the parent's sparse adapter. */
export const KERNEL_COREUTILS_SPARSE_POINTERS: Readonly<
  Record<
    KernelCoreutilsNamespace,
    Readonly<Record<string, readonly KernelCoreutilsSparsePointer[]>>
  >
> = {
  host_fs: {
    set_open_mode: noMemory,
    fd_mode: noMemory,
    path_mode: [path()],
    fd_size: noMemory,
    fd_blocks: noMemory,
    fd_owner: [output(1, 4), output(2, 4)],
    fd_chown: noMemory,
    path_chown: [path()],
    chmod: [path()],
    ftruncate: noMemory,
    open_tmpfile: [path(), output(5, 4)],
    set_open_direct: noMemory,
    path_access: [path()],
    path_size: [path()],
    path_blocks: [path()],
    path_owner: [path(), output(4, 4), output(5, 4)],
    fd_link: [path(2, 3)],
    fchmod: noMemory,
  },
  host_process: {
    fd_pipe: [output(0, 4), output(1, 4)],
    fd_dup: [output(1, 4)],
    fd_dup2: noMemory,
    fd_dup_min: [output(2, 4)],
    fd_setfd: noMemory,
    fd_getfd: [output(1, 4)],
    proc_closefrom: noMemory,
    fd_record_lock: noMemory,
    proc_umask: [output(1, 4)],
  },
  host_user: {
    getuid: [output(0, 4)],
    getgid: [output(0, 4)],
    geteuid: [output(0, 4)],
    getegid: [output(0, 4)],
    getresuid: noMemory,
    getresgid: noMemory,
    setuid: noMemory,
    seteuid: noMemory,
    setreuid: noMemory,
    setresuid: noMemory,
    setgid: noMemory,
    setegid: noMemory,
    setregid: noMemory,
    setresgid: noMemory,
    getgroups: noMemory,
    setgroups: noMemory,
    isatty: [output(1, 4)],
    getpwuid: noMemory,
    getpwnam: noMemory,
    getpwent: noMemory,
    getgrgid: noMemory,
    getgrnam: noMemory,
    getgrent: noMemory,
  },
  host_net: {
    net_socket: noMemory,
    net_connect: noMemory,
    net_send: noMemory,
    net_recv: noMemory,
    net_close: noMemory,
    net_getaddrinfo: noMemory,
    net_tls_connect: noMemory,
    net_setsockopt: noMemory,
    net_getsockname: noMemory,
    net_getpeername: noMemory,
    net_poll: noMemory,
    net_bind: noMemory,
    net_listen: noMemory,
    net_accept: noMemory,
    net_sendto: noMemory,
    net_recvfrom: noMemory,
  },
};

export function kernelCoreutilsPointerLength(
  pointer: KernelCoreutilsSparsePointer,
  args: readonly (number | bigint)[],
): number {
  const length =
    typeof pointer.length === "number"
      ? pointer.length
      : Number(args[pointer.length.argument] ?? 0);
  return length >>> 0;
}

export function prepareKernelCoreutilsSparseImport(
  memory: WasiMemory,
  args: readonly (number | bigint)[],
  pointers: readonly KernelCoreutilsSparsePointer[],
): {
  readonly memory: WebAssembly.Memory;
  readonly args: readonly (number | bigint)[];
  readonly copyOutputs: (target: WasiMemory) => void;
} {
  const ranges = pointers.map((pointer) => {
    const address = Number(args[pointer.argument] ?? 0) >>> 0;
    const size = kernelCoreutilsPointerLength(pointer, args);
    let valid = true;
    try {
      memory.validateRange(address, size);
    } catch {
      valid = false;
    }
    return { ...pointer, address, size, valid, offset: 0 };
  });

  let total = 0;
  for (const range of ranges) {
    if (!range.valid || range.size === 0) continue;
    if (range.maxBytes !== undefined && range.size > range.maxBytes) {
      throw new RangeError("Coreutils sparse pointer exceeds its ABI transfer limit");
    }
    total = align8(total);
    range.offset = total;
    total += range.size;
    if (total > KERNEL_COREUTILS_MAX_TRANSFER_BYTES) {
      throw new TypeError("Coreutils sparse import exceeds the memory transfer limit");
    }
  }

  const pages = Math.max(1, Math.ceil((total + 16) / 65_536));
  const scratch = new WebAssembly.Memory({ initial: pages });
  const scratchBytes = new Uint8Array(scratch.buffer);
  const mappedArgs = [...args];
  for (const range of ranges) {
    if (!range.valid) {
      mappedArgs[range.argument] = scratch.buffer.byteLength + 1;
      continue;
    }
    mappedArgs[range.argument] = range.size === 0 ? 0 : range.offset;
    if (range.size > 0) scratchBytes.set(memory.range(range.address, range.size), range.offset);
  }

  return {
    memory: scratch,
    args: mappedArgs,
    copyOutputs(target) {
      for (const range of ranges) {
        if (range.valid && range.output && range.size > 0) {
          target
            .range(range.address, range.size)
            .set(scratchBytes.subarray(range.offset, range.offset + range.size));
        }
      }
    },
  };
}

function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

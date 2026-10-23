import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import {
  createKernelWasiFileSystemAdapter,
  type KernelWasiSignalOptions,
} from "./KernelWasiFileSystemAdapter.ts";
import { createAgentOsWasiArgumentTransform } from "./AgentOsWasi.ts";
import { runKernelExecution } from "./process/KernelExecution.ts";
import { WasiFileSystem } from "./wasi/internal_wasi_fs.ts";
import { WasiHost } from "./wasi/internal_wasi_host.ts";
import { mapErrno, runAsync, type WasiCall } from "./wasi/internal_wasi_calls.ts";
import { WasiExit } from "./wasi/internal_wasi_memory.ts";
import { validateOptions } from "./wasi/internal_wasi_options.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";
import { KernelFileIoSequence } from "./KernelFileIoSequence.ts";
import {
  KERNEL_SYSCALL_MAX_IO_BYTES,
  MAX_TRANSFER_BYTES,
  type KernelSyscallRequest,
  type KernelSyscallResponse,
} from "./KernelSyscallPort.ts";
import { FDFLAGS } from "./wasi/internal_wasi_descriptors.ts";

export interface KernelSyscallHostOptions extends KernelWasiSignalOptions {
  readonly filesystem: KernelFileSystem;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly agentOsPreopens?: boolean;
}

/** Runs the existing WASI handlers against the process owner's descriptors, without a guest heap. */
export function createKernelSyscallHost(options: KernelSyscallHostOptions) {
  const memory = new SyscallMemory();
  const sequence = new KernelFileIoSequence(options.filesystem);
  const filesystem = new WasiFileSystem(memory, [], [], {
    table: options.filesystem.descriptors,
    ownership: "borrowed",
    fileBytes: () => options.filesystem.fileBytes,
    pathCheck: options.filesystem.assertWasiPathVisible.bind(options.filesystem),
    creation: {
      createInode: options.filesystem.createInode.bind(options.filesystem),
      takeCreateMode: options.filesystem.takeNextCreateMode.bind(options.filesystem),
    },
  });
  const validated = validateOptions({
    version: "preview1",
    args: [...options.args],
    env: { ...options.env },
  });
  const system = new WasiHost(
    memory,
    validated.args,
    validated.env,
    true,
    filesystem.descriptors,
    options.signal,
  );
  const imports = new Map(
    Object.entries({
      ...system.imports,
      ...createKernelWasiFileSystemAdapter(options.filesystem, options)(memory, filesystem.imports),
    }),
  );
  const transform = options.agentOsPreopens
    ? createAgentOsWasiArgumentTransform(options.filesystem)
    : undefined;
  let busy = false;
  let closed = false;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(options.signal.reason);
    if (!busy) {
      sequence.release();
    }
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const io = (name: string, args: readonly (number | bigint)[]) => {
    if (!["fd_read", "fd_write", "fd_pread", "fd_pwrite"].includes(name)) return undefined;
    const descriptor = options.filesystem.descriptors.get(Number(args[0]));
    return {
      descriptor:
        descriptor.kind === "file" || descriptor.kind === "stdio"
          ? descriptor.kind
          : ("other" as const),
      nonblocking: descriptor.kind === "stdio" && (descriptor.flags & FDFLAGS.NONBLOCK) !== 0,
    };
  };

  return {
    async call(request: KernelSyscallRequest): Promise<KernelSyscallResponse> {
      if (closed || busy) throw new Error("Syscall owner is unavailable or already executing");
      controller.signal.throwIfAborted();
      const handler = imports.get(request.name);
      if (!handler) {
        sequence.release();
        throw new Error("Missing WASI syscall");
      }
      const transferred = request.transferOffset !== undefined;
      const offset = request.transferOffset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        sequence.release();
        throw new TypeError("Invalid syscall transfer offset");
      }
      if (
        request.transferLength !== undefined &&
        (!Number.isSafeInteger(request.transferLength) ||
          request.transferLength < 0 ||
          request.transferLength > MAX_TRANSFER_BYTES)
      ) {
        sequence.release();
        throw new TypeError("Invalid syscall transfer length");
      }
      busy = true;
      try {
        let response: KernelSyscallResponse;
        let moved = 0;
        let descriptorIo: ReturnType<typeof io>;
        try {
          try {
            const args = [...(transform?.(request.name, request.args) ?? request.args)];
            if (transferred && request.name === "fd_readdir") {
              args[1] = Number(args[1]) + offset;
              args[2] = Number(args[2]) - offset;
            } else if (transferred && request.name === "path_readlink") {
              args[3] = Number(args[3]) + offset;
              args[4] = Number(args[4]) - offset;
            }
            memory.bind(
              request.memorySize,
              request.regions,
              transferred
                ? Math.min(
                    KERNEL_SYSCALL_MAX_IO_BYTES,
                    request.transferLength ?? KERNEL_SYSCALL_MAX_IO_BYTES,
                  )
                : undefined,
              {
                offset,
                readOnce: transferred && request.name === "fd_read",
              },
            );
            const owner = await sequence.begin(request, args, memory, controller.signal);
            memory.ioOwner = owner;
            descriptorIo = transferred ? io(request.name, args) : undefined;
            const operation: WasiCall<number> = Reflect.apply(handler, undefined, args);
            const value = await runKernelExecution(controller.signal, () => runAsync(operation));
            moved = value === 0 ? transferCount(request, memory) : 0;
            sequence.complete(request, moved, memory.transferLimit, value === 0);
            response = {
              kind: "return",
              value,
              regions: memory.snapshot(),
              ...(descriptorIo === undefined ? {} : { io: descriptorIo }),
            };
          } catch (error) {
            sequence.release();
            if (error instanceof KernelProcessSignal)
              response = { kind: "signal", signal: error.signal };
            else if (error instanceof WasiExit) response = { kind: "exit", code: error.code };
            else {
              response = { kind: "return", value: mapErrno(error), regions: memory.snapshot() };
            }
          }
        } finally {
          memory.clear();
        }
        return response;
      } finally {
        busy = false;
        if (closed || controller.signal.aborted) {
          sequence.release();
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      options.signal.removeEventListener("abort", abort);
      controller.abort();
      if (!busy) {
        sequence.release();
        memory.clear();
      }
    },
  };
}

function transferCount(request: KernelSyscallRequest, memory: SyscallMemory) {
  let argument: number;
  switch (request.name) {
    case "fd_read":
    case "fd_write":
      argument = 3;
      break;
    case "fd_pread":
    case "fd_pwrite":
    case "fd_readdir":
      argument = 4;
      break;
    case "path_readlink":
      argument = 5;
      break;
    default:
      return 0;
  }
  const bytes = memory.range(Number(request.args[argument]), 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

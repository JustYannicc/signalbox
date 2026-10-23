import {
  KERNEL_SYSCALL_MAX_IO_BYTES,
  type KernelSyscallPort,
} from "../kernel/KernelSyscallPort.ts";
import { KernelProcessSignal, kernelProcessExitStatus } from "../kernel/KernelProcessSignal.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";
import { childWasiIo } from "./ChildWasiIo.ts";
import type {
  KernelBashImportCall,
  KernelBashOperationEffect,
  KernelBashOperationResult,
} from "../kernel/KernelBashCheckpoint.ts";
import type { BashAsyncifyOperationHooks } from "../kernel/KernelBashCheckpoint.ts";

type WasmArgument = number | bigint;
type WasiMemoryPlan = (
  regions: MemoryRegions,
  args: readonly WasmArgument[],
  options: EncodedOptions,
) => void;

interface JSPI {
  Suspending: new (fn: (...args: WasmArgument[]) => Promise<number>) => WebAssembly.ImportValue;
  promising(
    fn: (...args: WasmArgument[]) => unknown,
  ): (...args: WasmArgument[]) => Promise<unknown>;
}

interface EncodedOptions {
  readonly argsCount: number;
  readonly argsSize: number;
  readonly envCount: number;
  readonly envSize: number;
}

const WASI_NAMESPACES = new Set(["wasi_snapshot_preview1", "wasi_unstable"]);
const encoder = new TextEncoder();

const noMemory: WasiMemoryPlan = () => {};
const pointer = (args: readonly WasmArgument[], index: number): number => {
  const value = args[index];
  return typeof value === "number" ? value : 0;
};

const MEMORY_PLANS: Readonly<Record<string, WasiMemoryPlan>> = {
  args_sizes_get(regions, args) {
    regions.add(pointer(args, 0), 4, "out");
    regions.add(pointer(args, 1), 4, "out");
  },
  args_get(regions, args, options) {
    regions.add(pointer(args, 0), options.argsCount * 4, "out");
    regions.add(pointer(args, 1), options.argsSize, "out");
  },
  environ_sizes_get(regions, args) {
    regions.add(pointer(args, 0), 4, "out");
    regions.add(pointer(args, 1), 4, "out");
  },
  environ_get(regions, args, options) {
    regions.add(pointer(args, 0), options.envCount * 4, "out");
    regions.add(pointer(args, 1), options.envSize, "out");
  },
  clock_res_get(regions, args) {
    regions.add(pointer(args, 1), 8, "out");
  },
  clock_time_get(regions, args) {
    regions.add(pointer(args, 2), 8, "out");
  },
  random_get(regions, args) {
    regions.add(pointer(args, 0), pointer(args, 1), "out");
  },
  sched_yield: noMemory,
  proc_exit: noMemory,
  proc_raise: noMemory,
  poll_oneoff(regions, args) {
    const count = pointer(args, 2) >>> 0;
    if (count === 0 || count > 1024) return;
    regions.add(pointer(args, 0), count * 48, "in");
    regions.add(pointer(args, 1), count * 32, "out");
    regions.add(pointer(args, 3), 4, "out");
  },
  sock_accept: noMemory,
  sock_recv: noMemory,
  sock_send: noMemory,
  sock_shutdown: noMemory,
  fd_advise: noMemory,
  fd_allocate: noMemory,
  fd_close: noMemory,
  fd_datasync: noMemory,
  fd_fdstat_get(regions, args) {
    regions.add(pointer(args, 1), 24, "out");
  },
  fd_fdstat_set_flags: noMemory,
  fd_fdstat_set_rights: noMemory,
  fd_filestat_get(regions, args) {
    regions.add(pointer(args, 1), 64, "out");
  },
  fd_filestat_set_size: noMemory,
  fd_filestat_set_times: noMemory,
  fd_pread(regions, args) {
    regions.add(pointer(args, 4), 4, "out");
    regions.addIovecs(pointer(args, 1), pointer(args, 2), "out");
  },
  fd_pwrite(regions, args) {
    regions.add(pointer(args, 4), 4, "out");
    regions.addIovecs(pointer(args, 1), pointer(args, 2), "in");
  },
  fd_prestat_get(regions, args) {
    regions.add(pointer(args, 1), 8, "out");
  },
  fd_prestat_dir_name(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "out");
  },
  fd_read(regions, args) {
    regions.add(pointer(args, 3), 4, "out");
    regions.addIovecs(pointer(args, 1), pointer(args, 2), "out");
  },
  fd_readdir(regions, args) {
    regions.add(pointer(args, 1), Math.min(pointer(args, 2) >>> 0, regions.transferLimit), "out");
    regions.add(pointer(args, 4), 4, "out");
  },
  fd_renumber: noMemory,
  fd_seek(regions, args) {
    regions.add(pointer(args, 3), 8, "out");
  },
  fd_sync: noMemory,
  fd_tell(regions, args) {
    regions.add(pointer(args, 1), 8, "out");
  },
  fd_write(regions, args) {
    regions.add(pointer(args, 3), 4, "out");
    regions.addIovecs(pointer(args, 1), pointer(args, 2), "in");
  },
  path_create_directory(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "in");
  },
  path_filestat_get(regions, args) {
    regions.add(pointer(args, 2), pointer(args, 3), "in");
    regions.add(pointer(args, 4), 64, "out");
  },
  path_filestat_set_times(regions, args) {
    regions.add(pointer(args, 2), pointer(args, 3), "in");
  },
  path_link(regions, args) {
    regions.add(pointer(args, 2), pointer(args, 3), "in");
    regions.add(pointer(args, 5), pointer(args, 6), "in");
  },
  path_open(regions, args) {
    regions.add(pointer(args, 2), pointer(args, 3), "in");
    regions.add(pointer(args, 8), 4, "out");
  },
  path_readlink(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "in");
    regions.add(pointer(args, 3), Math.min(pointer(args, 4) >>> 0, regions.transferLimit), "out");
    regions.add(pointer(args, 5), 4, "out");
  },
  path_remove_directory(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "in");
  },
  path_rename(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "in");
    regions.add(pointer(args, 4), pointer(args, 5), "in");
  },
  path_symlink(regions, args) {
    regions.add(pointer(args, 0), pointer(args, 1), "in");
    regions.add(pointer(args, 3), pointer(args, 4), "in");
  },
  path_unlink_file(regions, args) {
    regions.add(pointer(args, 1), pointer(args, 2), "in");
  },
};

/** Exposed when a reactor exits from `_initialize`, whose API has no status result. */
export class ChildWasiExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`WASI process exited with code ${code >>> 0}`);
    this.name = "ChildWasiExit";
    this.code = code >>> 0;
  }
}

export interface ChildWasiOptions {
  readonly module: WebAssembly.Module;
  readonly syscalls: KernelSyscallPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Product Bash uses Asyncify checkpoints instead of JSPI's opaque suspended import stack. */
  readonly asyncify?: BashAsyncifyOperationHooks;
}

/** Keeps linear memory in the child and sends only each syscall's ABI ranges to its owner. */
export function createChildWasi(options: ChildWasiOptions) {
  const wasm = WebAssembly as unknown as JSPI;
  if (typeof wasm.Suspending !== "function" || typeof wasm.promising !== "function") {
    throw new Error("The child WASI bridge requires WebAssembly JSPI support");
  }

  const normalizedArgs = options.args.map(String);
  const normalizedEnv = Object.entries(options.env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  if ([...normalizedArgs, ...normalizedEnv].some((value) => value.includes("\0"))) {
    throw new TypeError("WASI args and environment values must not contain NUL");
  }
  const encoded: EncodedOptions = {
    argsCount: normalizedArgs.length,
    argsSize: encodedSize(normalizedArgs),
    envCount: normalizedEnv.length,
    envSize: encodedSize(normalizedEnv),
  };

  let instance: WebAssembly.Instance | undefined;
  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = Object.create(null) as WebAssembly.Imports;

  for (const imported of WebAssembly.Module.imports(options.module)) {
    if (!WASI_NAMESPACES.has(imported.module)) continue;
    if (imported.kind !== "function" || !Object.hasOwn(MEMORY_PLANS, imported.name)) {
      throw new TypeError(`Unsupported WASI import ${imported.module}.${imported.name}`);
    }

    const namespace = (imports[imported.module] ??= Object.create(null)) as Record<
      string,
      WebAssembly.ImportValue
    >;
    if (options.asyncify !== undefined) {
      namespace[imported.name] = (...args: WasmArgument[]): number => {
        const resumed = options.asyncify!.landing();
        if (resumed !== undefined) return resumed;
        if (instance === undefined || memory === undefined) {
          throw new Error("Child WASI memory has not been bound");
        }
        if (imported.name === "random_get") return randomGet(args, memory);
        const regions = new MemoryRegions(memory);
        MEMORY_PLANS[imported.name]!(regions, args, encoded);
        const request = {
          name: imported.name,
          args,
          memorySize: memory.buffer.byteLength,
          regions: regions.snapshot(),
        };
        return options.asyncify!.suspend(
          { kind: "wasi", request },
          {
            namespace: imported.module as "wasi_snapshot_preview1" | "wasi_unstable",
            name: imported.name,
            args,
          },
        );
      };
      continue;
    }
    namespace[imported.name] = new wasm.Suspending(async (...args): Promise<number> => {
      if (instance === undefined || memory === undefined) {
        throw new Error("Child WASI memory has not been bound");
      }
      // Random bytes use the child's own heap and crypto source, with no descriptor state to share.
      if (imported.name === "random_get") {
        const start = pointer(args, 0) >>> 0;
        const length = pointer(args, 1) >>> 0;
        if (start + length > memory.buffer.byteLength) return 21;
        for (let offset = 0; offset < length; offset += 65_536) {
          crypto.getRandomValues(
            new Uint8Array(memory.buffer, start + offset, Math.min(65_536, length - offset)),
          );
        }
        return 0;
      }
      const io = await childWasiIo({
        name: imported.name,
        args,
        memory,
        syscalls: options.syscalls,
      });
      if (typeof io === "number") return io;
      if (io?.kind === "exit") throw new ChildWasiExit(io.code);
      if (io?.kind === "signal") throw new KernelProcessSignal(io.signal);
      const regions = new MemoryRegions(memory, KERNEL_SYSCALL_MAX_IO_BYTES);
      MEMORY_PLANS[imported.name]!(regions, args, encoded);
      const requestRegions = regions.snapshot();
      const response = await options.syscalls.call({
        name: imported.name,
        args,
        memorySize: memory.buffer.byteLength,
        regions: requestRegions,
        transferOffset: 0,
      });
      if (response.kind === "exit") throw new ChildWasiExit(response.code);
      if (response.kind === "signal") throw new KernelProcessSignal(response.signal);
      if (imported.name === "proc_exit") {
        throw new Error("WASI proc_exit returned without exiting the child");
      }
      regions.apply(response.regions);
      return response.value;
    });
  }

  function bind(candidate: WebAssembly.Instance): void {
    if (!(candidate instanceof WebAssembly.Instance)) {
      throw new TypeError("Child WASI bind requires a WebAssembly.Instance");
    }
    if (instance !== undefined && instance !== candidate) {
      throw new Error("Child WASI is already bound to another instance");
    }
    const candidateMemory = candidate.exports.memory;
    if (!(candidateMemory instanceof WebAssembly.Memory)) {
      throw new TypeError("Child WASI instance must export its WebAssembly.Memory as memory");
    }
    instance = candidate;
    memory = candidateMemory;
  }

  function bindIfNeeded(candidate: WebAssembly.Instance): WebAssembly.Instance {
    if (instance === undefined) bind(candidate);
    if (instance === undefined) {
      throw new Error("Child WASI failed to bind its WebAssembly.Instance");
    }
    if (instance !== candidate) {
      throw new Error("Child WASI is bound to a different WebAssembly.Instance");
    }
    return instance;
  }

  function invoke(fn: WebAssembly.ExportValue, ...args: WasmArgument[]): Promise<unknown> {
    if (typeof fn !== "function") throw new TypeError("Expected a WebAssembly function export");
    // Bash also has uninstrumented env imports that still suspend through JSPI.
    return wasm.promising(fn as (...args: WasmArgument[]) => unknown)(...args);
  }

  function applyOperation(
    call: KernelBashImportCall,
    result: KernelBashOperationResult,
  ): KernelBashOperationEffect {
    if (result.kind !== "wasi") throw new TypeError("WASI import received a non-WASI result");
    if (memory === undefined) throw new Error("Child WASI memory has not been bound");
    const response = result.value;
    if (response.kind === "exit")
      return {
        kind: "exit",
        status: { exitCode: response.code >>> 0, signal: 0, coreDumped: false },
      };
    if (response.kind === "signal") throw new KernelProcessSignal(response.signal);
    if (call.name === "proc_exit") {
      throw new Error("WASI proc_exit returned without exiting the child");
    }
    const regions = new MemoryRegions(memory);
    MEMORY_PLANS[call.name]!(regions, call.args, encoded);
    regions.apply(response.regions);
    return { kind: "resume", value: response.value };
  }

  async function start(candidate: WebAssembly.Instance): Promise<number> {
    const bound = bindIfNeeded(candidate);
    const start = bound.exports._start;
    if (start === undefined) throw new TypeError("Child WASI instance does not export _start");
    try {
      await invoke(start);
      return 0;
    } catch (error) {
      if (error instanceof ChildWasiExit) return error.code;
      throw error;
    }
  }

  return {
    imports,
    bind,
    async initialize(candidate: WebAssembly.Instance): Promise<void> {
      const bound = bindIfNeeded(candidate);
      const initialize = bound.exports._initialize;
      if (initialize === undefined) return;
      await invoke(initialize);
    },
    start,
    startProcess: (candidate: WebAssembly.Instance) =>
      kernelProcessExitStatus(() => start(candidate)),
    applyOperation,
    run(fn: WebAssembly.ExportValue, ...args: WasmArgument[]): Promise<unknown> {
      if (instance === undefined) throw new Error("Child WASI has not been bound");
      return invoke(fn, ...args).catch((error: unknown) => {
        if (error instanceof ChildWasiExit) return error.code;
        throw error;
      });
    },
  };
}

function randomGet(args: readonly WasmArgument[], memory: WebAssembly.Memory): number {
  const start = pointer(args, 0) >>> 0;
  const length = pointer(args, 1) >>> 0;
  if (start + length > memory.buffer.byteLength) return 21;
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(
      new Uint8Array(memory.buffer, start + offset, Math.min(65_536, length - offset)),
    );
  }
  return 0;
}

function encodedSize(values: readonly string[]): number {
  let size = 0;
  for (const value of values) size += encoder.encode(value).byteLength + 1;
  return size;
}

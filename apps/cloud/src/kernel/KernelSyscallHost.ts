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
import type { KernelSyscallRequest, KernelSyscallResponse } from "./KernelSyscallPort.ts";
import { kernelPayloadBudget, type KernelPayloadWindow } from "./KernelPayloadBudget.ts";

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
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  let window: KernelPayloadWindow | undefined;
  const ready = kernelPayloadBudget.open(controller.signal).then((value) => {
    if (closed) value.release();
    else window = value;
  });
  void ready.catch(() => {});

  return {
    ready,
    async call(request: KernelSyscallRequest): Promise<KernelSyscallResponse> {
      if (closed || busy) throw new Error("Syscall owner is unavailable or already executing");
      options.signal.throwIfAborted();
      const handler = imports.get(request.name);
      if (!handler) throw new Error("Missing WASI syscall");
      busy = true;
      try {
        await ready;
        if (window === undefined) throw new Error("Syscall payload window is unavailable");
        window.acknowledge();
        memory.bind(request.memorySize, request.regions, window.bytes);
        try {
          const args = transform?.(request.name, request.args) ?? request.args;
          const operation: WasiCall<number> = Reflect.apply(handler, undefined, args);
          const value = await runKernelExecution(options.signal, () => runAsync(operation));
          const regions = memory.snapshot();
          const responseBytes = new Set(regions.map((region) => region.bytes.buffer));
          return {
            kind: "return",
            value,
            regions,
            transferWindow: window.complete(
              [...responseBytes].reduce((total, buffer) => total + buffer.byteLength, 0),
            ),
          };
        } catch (error) {
          if (error instanceof KernelProcessSignal) return { kind: "signal", signal: error.signal };
          if (error instanceof WasiExit) return { kind: "exit", code: error.code };
          const regions = memory.snapshot();
          const buffers = new Set(regions.map((region) => region.bytes.buffer));
          return {
            kind: "return",
            value: mapErrno(error),
            regions,
            transferWindow: window.complete(
              [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0),
            ),
          };
        }
      } finally {
        memory.clear();
        busy = false;
      }
    },
    close() {
      if (busy) throw new Error("Syscall owner is still executing");
      closed = true;
      memory.clear();
      options.signal.removeEventListener("abort", abort);
      controller.abort();
      window?.release();
    },
  };
}

import { createAgentOsWasiArgumentTransform } from "./AgentOsWasi.ts";
import { KernelDescriptors } from "./KernelDescriptors.ts";
import { createKernelWasiFileSystemAdapter } from "./KernelWasiSignals.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import type { AsyncWASIOptions } from "./Wasi.ts";
import { WasiLifecycle } from "./wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "./wasi/internal_wasi_options.ts";
import { runKernelExecution } from "./process/KernelExecution.ts";

export interface KernelAsyncWasiOptions {
  readonly filesystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  /** Enables the pinned agentOS guest ABI for hidden preopen descriptor operands. */
  readonly agentOsPreopens?: boolean;
  /** Mounts and streams already belong to filesystem; this host borrows its table. */
  readonly options?: Omit<
    AsyncWASIOptions,
    "mounts" | "stdio" | "preopens" | "stdin" | "stdout" | "stderr"
  >;
}

/** Public kernel binding for a command or reactor that shares its owner's fds. */
export function createKernelAsyncWasi(input: KernelAsyncWasiOptions) {
  const execution = new AbortController();
  const lifecycle = new WasiLifecycle(
    validateOptions(input.options ?? { version: "preview1" }),
    true,
    {
      table: input.filesystem.descriptors,
      ownership: "borrowed",
      fileBytes: () => input.filesystem.fileBytes,
      pathCheck: input.filesystem.assertWasiPathVisible.bind(input.filesystem),
      creation: {
        createInode: input.filesystem.createInode.bind(input.filesystem),
        takeCreateMode: input.filesystem.takeNextCreateMode.bind(input.filesystem),
      },
    },
    input.agentOsPreopens ? createAgentOsWasiArgumentTransform(input.filesystem) : undefined,
    createKernelWasiFileSystemAdapter(input.filesystem),
    execution.signal,
  );
  return {
    descriptors: new KernelDescriptors(input.filesystem.descriptors, input.wakes),
    wakes: input.wakes,
    wasi: {
      get wasiImport() {
        return lifecycle.wasiImport;
      },
      getImportObject: () => lifecycle.getImportObject(),
      async start(instance: object, signal?: AbortSignal) {
        if (signal === undefined) {
          execution.signal.throwIfAborted();
          return lifecycle.startAsync(instance);
        }
        const abort = () => execution.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          execution.signal.throwIfAborted();
          return await runKernelExecution(signal, () => lifecycle.startAsync(instance));
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      initialize: (instance: object) => lifecycle.initializeAsync(instance),
      run: (fn: (...args: Array<number | bigint>) => unknown, ...args: Array<number | bigint>) =>
        lifecycle.runAsync(fn, ...args),
      // The caller closes its filesystem after all reactors using it have stopped.
      close: () => lifecycle.closeAsync(),
    },
  };
}

export type KernelAsyncWasi = ReturnType<typeof createKernelAsyncWasi>;

import { KernelDescriptors } from "./KernelDescriptors.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import type { AsyncWASIOptions } from "./Wasi.ts";
import { WasiLifecycle } from "./wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "./wasi/internal_wasi_options.ts";

export interface KernelAsyncWasiOptions {
  readonly filesystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  /** Mounts and streams already belong to filesystem; this host borrows its table. */
  readonly options?: Omit<
    AsyncWASIOptions,
    "mounts" | "stdio" | "preopens" | "stdin" | "stdout" | "stderr"
  >;
}

/** Public kernel binding for a command or reactor that shares its owner's fds. */
export function createKernelAsyncWasi(input: KernelAsyncWasiOptions) {
  const lifecycle = new WasiLifecycle(
    validateOptions(input.options ?? { version: "preview1" }),
    true,
    { table: input.filesystem.descriptors, ownership: "borrowed" },
  );
  return {
    descriptors: new KernelDescriptors(input.filesystem.descriptors, input.wakes),
    wakes: input.wakes,
    wasi: {
      get wasiImport() {
        return lifecycle.wasiImport;
      },
      getImportObject: () => lifecycle.getImportObject(),
      start: (instance: object) => lifecycle.startAsync(instance),
      initialize: (instance: object) => lifecycle.initializeAsync(instance),
      run: (fn: (...args: Array<number | bigint>) => unknown, ...args: Array<number | bigint>) =>
        lifecycle.runAsync(fn, ...args),
      // The caller closes its filesystem after all reactors using it have stopped.
      close: () => lifecycle.closeAsync(),
    },
  };
}

export type KernelAsyncWasi = ReturnType<typeof createKernelAsyncWasi>;

import { createKernelBashReactor } from "../kernel/KernelBashReactor.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { createChildWasi } from "./ChildWasi.ts";
import { createChildBashImports } from "./ChildBashImports.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";

export interface ChildBashOptions {
  readonly module: WebAssembly.Module;
  readonly residentWasmBudgetBytes?: number;
  readonly credentials: KernelBashCredentials;
  readonly pid: number;
  readonly port: KernelBashPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly snapshot?: KernelBashForkSource | undefined;
  readonly createForkSource?: (source: KernelBashForkSource) => KernelBashForkSource;
}

/** Run the unchanged GNU Bash image in the child, including its Nimbus Asyncify ABI. */
export function createChildBash(options: ChildBashOptions) {
  return createKernelBashReactor({
    ...options,
    // Half of Workers' 128 MiB leaves room for JS, RPC buffers and guest growth.
    residentWasmBudgetBytes: options.residentWasmBudgetBytes ?? 64 * 1024 * 1024,
    createBinding(port) {
      const wasi = createChildWasi({ ...options, syscalls: port });
      const bash = createChildBashImports({ module: options.module, port });
      return {
        imports: { ...wasi.imports, ...bash.imports },
        bind(instance) {
          wasi.bind(instance);
          bash.bind(instance);
        },
        run: (start) => wasi.run(start),
      };
    },
  });
}

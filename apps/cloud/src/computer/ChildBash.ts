import { createKernelBashReactor } from "../kernel/KernelBashReactor.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { createChildWasi } from "./ChildWasi.ts";
import { createChildBashImports } from "./ChildBashImports.ts";

export interface ChildBashOptions {
  readonly module: WebAssembly.Module;
  readonly credentials: KernelBashCredentials;
  readonly pid: number;
  readonly port: KernelBashPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Run the unchanged GNU Bash image in the child, including its Nimbus Asyncify ABI. */
export function createChildBash(options: ChildBashOptions) {
  return createKernelBashReactor({
    ...options,
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

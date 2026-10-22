import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import { createChildWasi } from "./ChildWasi.ts";
import { createChildCoreutilsImports } from "./ChildCoreutilsImports.ts";

export interface ChildCoreutilsOptions {
  readonly module: WebAssembly.Module;
  readonly port: KernelCoreutilsPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Run one pinned AgentOS coreutils module while its parent owns descriptors and files. */
export function createChildCoreutils(options: ChildCoreutilsOptions) {
  let started = false;
  return {
    async run() {
      if (started) throw new Error("Coreutils child has already started");
      started = true;
      const wasi = createChildWasi({ ...options, syscalls: options.port });
      const coreutils = createChildCoreutilsImports(options);
      const instance = new WebAssembly.Instance(options.module, {
        ...wasi.imports,
        ...coreutils.imports,
      });
      wasi.bind(instance);
      coreutils.bind(instance);
      return wasi.startProcess(instance);
    },
  };
}

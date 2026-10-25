import type { KernelGitPort } from "../kernel/KernelGitPort.ts";
import { createChildWasi } from "./ChildWasi.ts";
import { createChildGitImports } from "./ChildGitImports.ts";

export interface ChildGitOptions {
  readonly module: WebAssembly.Module;
  readonly port: KernelGitPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Instantiates the pinned Git module in the child and forwards only owned calls. */
export function createChildGit(options: ChildGitOptions) {
  let started = false;
  return {
    async run() {
      if (started) throw new Error("Git child has already started");
      started = true;
      const wasi = createChildWasi({ ...options, syscalls: options.port });
      const nimbus = createChildGitImports(options);
      const instance = new WebAssembly.Instance(options.module, {
        ...wasi.imports,
        ...nimbus.imports,
      });
      wasi.bind(instance);
      nimbus.bind(instance);
      return wasi.startProcess(instance);
    },
  };
}

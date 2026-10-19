import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import { createChildBusyboxImports } from "./ChildBusyboxImports.ts";
import { createChildWasi } from "./ChildWasi.ts";

export interface ChildBusyboxOptions {
  readonly module: WebAssembly.Module;
  readonly port: KernelBusyboxPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Instantiate only inside the child; the facet retains the prepared process resources. */
export function createChildBusybox(options: ChildBusyboxOptions) {
  let started = false;
  return {
    async run() {
      if (started) throw new Error("BusyBox child has already started");
      started = true;
      const wasi = createChildWasi({ ...options, syscalls: options.port });
      const nimbus = createChildBusyboxImports(options);
      const instance = new WebAssembly.Instance(options.module, {
        ...wasi.imports,
        ...nimbus.imports,
      });
      wasi.bind(instance);
      nimbus.bind(instance);
      return { exitCode: await wasi.start(instance), signal: 0, coreDumped: false } as const;
    },
  };
}

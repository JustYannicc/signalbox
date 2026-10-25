import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelBusyboxImports } from "./coreutils/KernelBusyboxImports.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";

export const KERNEL_BUSYBOX_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "bin/busybox.wasm",
  version: "1.37.0+nimbus.e9f019ab.io-buffer.1",
  buildRecipe: "infra/kernelPrograms/coreutils/build-busybox-buffered.sh",
  sha256: "6aefd645a67065f611b6cbdf78a5899def4404e01917375164a02426750d47ba",
  bytes: 295_812,
});

export interface KernelBusyboxProgramOptions {
  readonly module: WebAssembly.Module;
}

/** Run a pinned synchronous BusyBox applet with its original argv and shared fds. */
export function createKernelBusyboxProgram(options: KernelBusyboxProgramOptions) {
  return Object.freeze({
    kind: "async" as const,
    run: async (context: KernelAsyncProgramContext) => {
      const process = context.processes.info(context.identity.handle);
      if (process.status !== "ok") {
        throw Object.assign(new Error("BusyBox process identity is unavailable"), {
          code: "ESRCH",
        });
      }

      let memory: WebAssembly.Memory | undefined;
      const runtime = createKernelAsyncWasi({
        process: context,
        filesystem: context.filesystem,
        wakes: context.wakes,
        agentOsPreopens: true,
        options: {
          version: "preview1",
          args: [...context.args],
          env: { ...context.env },
        },
      });
      const wasi = runtime.wasi;

      try {
        const nimbus = createKernelBusyboxImports({
          module: options.module,
          memory: () => {
            if (memory === undefined) throw new Error("BusyBox guest memory is not bound");
            return memory;
          },
          filesystem: context.filesystem,
          pid: context.identity.pid,
          parentPid: process.value.parentPid,
        });
        const instance = new WebAssembly.Instance(options.module, {
          ...wasi.getImportObject(),
          ...nimbus,
        });
        if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
          throw new Error("BusyBox did not export memory");
        }
        memory = instance.exports.memory;
        const exitCode = await wasi.start(instance);
        return { exitCode, signal: 0, coreDumped: false } as const;
      } finally {
        await wasi.close();
      }
    },
  });
}

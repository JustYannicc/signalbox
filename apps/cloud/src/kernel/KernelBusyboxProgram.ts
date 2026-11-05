export {
  KERNEL_BUSYBOX_ARTIFACT,
  PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
} from "./KernelProgramArtifacts.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelBusyboxImports } from "./coreutils/KernelBusyboxImports.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";

/** ProductComputer's rebuilt BusyBox adds id while the kernel cat pin stays stable. */

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

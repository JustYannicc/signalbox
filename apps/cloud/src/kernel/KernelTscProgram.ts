import { ABI_VERSION } from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelProgramImplementation } from "./KernelProgramHost.ts";
import type { KernelExitStatus } from "./KernelProcessTable.ts";
import { createKernelTscFileSystem } from "./KernelTscFileSystemHost.ts";
import { runKernelTscReactor } from "./KernelTscReactor.ts";
import { runKernelExecution } from "./process/KernelExecution.ts";
import { WasiLifecycle } from "./wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "./wasi/internal_wasi_options.ts";

export const KERNEL_TSC_ARTIFACT = Object.freeze({
  repository: "https://github.com/pingdotgg/ts-rust",
  revision: "780dc512d64f40afebffa6a7028207649fb7ed1c",
  path: "bin/ts_rust.wasm",
  version: "7.0.0-dev",
  sha256: "fa457a73f575c92b679ffad60ea34f4c45451256df5a9e7c79d1f42e18bb3300",
  bytes: 6_215_774,
  license: "MIT AND Apache-2.0",
});

export const KERNEL_TSC_PROGRAM_MANIFEST = Object.freeze({
  name: "tsc-rs",
  version: `${KERNEL_TSC_ARTIFACT.version}+${KERNEL_TSC_ARTIFACT.revision.slice(0, 12)}`,
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([] as const),
  entrypoint: "tsc-rs-7.0.0-dev",
});

export const KERNEL_TSC_PROGRAM_PATH = "/bin/tsc-rs";

export interface KernelTscProgramOptions {
  readonly module: WebAssembly.Module;
}

/** Uses a borrowed descriptor table and the kernel's existing WASI lifecycle. */
export function createKernelTscProgram(
  options: KernelTscProgramOptions,
): Extract<KernelProgramImplementation, { readonly kind: "async" }> {
  const module = options.module;
  return Object.freeze({
    kind: "async" as const,
    run: (context: KernelAsyncProgramContext) => runKernelTscProgram(module, context),
  });
}

async function runKernelTscProgram(
  module: WebAssembly.Module,
  context: KernelAsyncProgramContext,
): Promise<KernelExitStatus> {
  const lifecycle = new WasiLifecycle(
    validateOptions({
      version: "preview1",
      env: { ...context.env },
      returnOnExit: true,
    }),
    true,
    {
      table: context.filesystem.descriptors,
      ownership: "borrowed",
      creation: {
        createInode: context.filesystem.createInode.bind(context.filesystem),
        takeCreateMode: context.filesystem.takeNextCreateMode.bind(context.filesystem),
      },
    },
  );
  const filesystem = createKernelTscFileSystem(context.filesystem);
  let exitCode = 0;
  let failure: unknown;
  let failed = false;
  try {
    exitCode = await runKernelExecution(context.signal, () =>
      runKernelTscReactor(module, {
        filesystem,
        cwd: context.filesystem.cwd,
        args: context.args,
        host: {
          wasiImports: lifecycle.getImportObject(),
          initialize: (instance) => lifecycle.initializeAsync(instance),
          run: async (tsRun) => Number(await lifecycle.runAsync(tsRun)),
        },
      }),
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await lifecycle.closeAsync();
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError([failure, cleanupError], "tsc-rs execution and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw cleanupError;
  }
  if (failed) throw failure;
  return Object.freeze({ exitCode, signal: 0, coreDumped: false });
}

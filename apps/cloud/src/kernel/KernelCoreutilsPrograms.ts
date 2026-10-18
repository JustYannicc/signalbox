import { ABI_VERSION, KernelProgramRegistry } from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { createKernelCoreutilsImports } from "./KernelCoreutilsImports.ts";
import type { KernelProgramBinding, KernelProgramImplementation } from "./KernelProgramHost.ts";

export const KERNEL_COREUTILS_VERSION = "0.3.5";

export const KERNEL_COREUTILS_COMMANDS = Object.freeze([
  "cat",
  "echo",
  "printf",
  "ls",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "pwd",
  "head",
  "tail",
  "wc",
  "uniq",
] as const);

export type KernelCoreutilsCommand = (typeof KERNEL_COREUTILS_COMMANDS)[number];

export type KernelCoreutilsModules = Partial<
  Readonly<Record<KernelCoreutilsCommand, WebAssembly.Module>>
>;

/** Run one pinned AgentOS coreutils module with the shared filesystem and fds. */
export function createKernelCoreutilsProgram(
  module: WebAssembly.Module,
): Extract<KernelProgramImplementation, { readonly kind: "async" }> {
  return Object.freeze({
    kind: "async" as const,
    run: async (context: KernelAsyncProgramContext) => {
      let memory: WebAssembly.Memory | undefined;
      const runtime = createKernelAsyncWasi({
        filesystem: context.filesystem,
        wakes: context.wakes,
        agentOsPreopens: true,
        options: {
          version: "preview1",
          args: [...context.args],
          env: { ...context.env },
        },
      });

      try {
        const imports = createKernelCoreutilsImports({
          module,
          memory: () => {
            if (memory === undefined) throw new Error("Coreutils guest memory is not bound");
            return memory;
          },
          fileSystem: context.filesystem,
          wakes: context.wakes,
          asyncMode: true,
        });
        const instance = new WebAssembly.Instance(module, {
          ...runtime.wasi.getImportObject(),
          ...imports,
        });
        if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
          throw new Error("Coreutils guest did not export memory");
        }
        memory = instance.exports.memory;
        const exitCode = await runtime.wasi.start(instance);
        return { exitCode, signal: 0, coreDumped: false } as const;
      } finally {
        await runtime.wasi.close();
      }
    },
  });
}

/** Register only modules the deployment includes; command paths stay explicit. */
export function registerKernelCoreutilsPrograms(
  registry: KernelProgramRegistry,
  modules: KernelCoreutilsModules,
): ReadonlyMap<string, KernelProgramBinding> {
  const bindings = new Map<string, KernelProgramBinding>();
  for (const command of KERNEL_COREUTILS_COMMANDS) {
    const module = modules[command];
    if (module === undefined) continue;

    const manifest = Object.freeze({
      name: `@agentos-software/coreutils/${command}`,
      version: KERNEL_COREUTILS_VERSION,
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint: `coreutils-${KERNEL_COREUTILS_VERSION}:${command}`,
    });
    const registered = registry.register(manifest);
    if (registered.status === "error") {
      throw Object.assign(
        new Error(
          `Could not register coreutils ${command}@${KERNEL_COREUTILS_VERSION}: ${registered.error.message}`,
        ),
        { code: registered.error.code },
      );
    }
    if (registered.status === "would_block") {
      throw new Error(
        `Coreutils registry unexpectedly blocked ${command}@${KERNEL_COREUTILS_VERSION}`,
      );
    }
    bindings.set(`/bin/${command}`, {
      manifest,
      implementation: createKernelCoreutilsProgram(module),
    });
  }
  return bindings;
}

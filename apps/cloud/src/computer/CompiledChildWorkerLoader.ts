import type { WorkerEntrypoint } from "cloudflare:workers";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { ChildWorkerModules } from "./ChildWorkerProgram.ts";
import { resolveChildWorkerLimits, type ChildWorkerLimits } from "./ChildWorkerLimits.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";

export type CompiledChildWorkerRegistry = ReadonlyMap<string, WebAssembly.Module>;

interface Entrypoint extends WorkerEntrypoint {
  run(
    command: KernelCommand,
    target: Parameters<ChildWorkerLoaderPort["run"]>[1],
  ): Promise<KernelCommandExit>;
}

type CompiledModules = Record<
  string,
  string | { readonly js: string } | { readonly wasm: ArrayBuffer | WebAssembly.Module }
>;

/** Compiled WASM cannot cross service RPC. Resolve immutable references in the loader's isolate. */
export function resolveCompiledChildWorkerModules(
  modules: ChildWorkerModules,
  registry: CompiledChildWorkerRegistry,
) {
  const resolved: CompiledModules = {};
  for (const [name, module] of Object.entries(modules)) {
    if (!name || name.split("/").includes("..")) throw new TypeError("Invalid child module name");
    if (typeof module === "string") {
      Object.defineProperty(resolved, name, { value: module, enumerable: true });
    } else if ("wasmReference" in module) {
      if (!/^[a-f0-9]{64}$/.test(module.wasmReference))
        throw new TypeError("Invalid child WASM reference");
      const wasm = registry.get(module.wasmReference);
      if (wasm === undefined) throw new Error("Unknown child WASM reference");
      Object.defineProperty(resolved, name, { value: Object.freeze({ wasm }), enumerable: true });
    } else if ("js" in module && typeof module.js === "string") {
      Object.defineProperty(resolved, name, {
        value: Object.freeze({ js: module.js }),
        enumerable: true,
      });
    } else if (
      "wasm" in module &&
      (module.wasm instanceof ArrayBuffer || module.wasm instanceof WebAssembly.Module)
    ) {
      Object.defineProperty(resolved, name, {
        value: Object.freeze({ wasm: module.wasm }),
        enumerable: true,
      });
    } else {
      throw new TypeError("Child WASM must use an ArrayBuffer or a registered compiled module");
    }
  }
  return Object.freeze(resolved);
}

/** The host chooses the budget and static modules; invocation payloads cannot raise that budget. */
export function createCompiledChildWorkerLoader(
  loader: WorkerLoader,
  registry: CompiledChildWorkerRegistry,
  configuredLimits?: ChildWorkerLimits,
): ChildWorkerLoaderPort {
  const limits = resolveChildWorkerLimits(configuredLimits);
  const modulesByHash = new Map(registry);
  for (const [hash, module] of modulesByHash) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !(module instanceof WebAssembly.Module)) {
      throw new TypeError("Expected pinned compiled child WASM modules");
    }
  }
  return {
    async run(input, target) {
      let modules: ReturnType<typeof resolveCompiledChildWorkerModules>;
      try {
        if (
          !input.mainModule ||
          !Object.hasOwn(input.modules, input.mainModule) ||
          (input.entrypoint !== undefined && !/^[a-zA-Z_$][\w$]*$/.test(input.entrypoint))
        )
          throw new TypeError("Invalid child entrypoint");
        if (resolveChildWorkerLimits(input.limits).cpuMs !== limits.cpuMs) {
          throw new RangeError("Child CPU budget differs from the host binding");
        }
        modules = resolveCompiledChildWorkerModules(input.modules, modulesByHash);
        const main = modules[input.mainModule];
        if (typeof main !== "string" && (main === undefined || !("js" in main))) {
          throw new TypeError("Child main module must contain JavaScript");
        }
      } catch (error) {
        // No loader call happened, so this invocation cannot own a running child.
        const completion = target as typeof target & { stopped(): void | Promise<void> };
        await completion.stopped();
        throw error;
      }
      const code = {
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: input.mainModule,
        modules,
        globalOutbound: null,
        limits,
      };
      // Installed workers-types predates compiled-module inputs supported by Worker Loader.
      // https://github.com/cloudflare/workerd/blob/fa8b9d343f00c200b8e8d314c541c33be9e1ee70/src/workerd/api/worker-loader.h#L73-L80
      const worker = loader.get(null, () => code as WorkerLoaderWorkerCode);
      return await worker
        .getEntrypoint<Entrypoint>(input.entrypoint, { limits })
        .run(input.command, target);
    },
  };
}

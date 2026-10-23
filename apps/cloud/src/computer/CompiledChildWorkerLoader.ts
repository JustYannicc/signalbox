import type { WorkerEntrypoint } from "cloudflare:workers";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { ChildWorkerModules } from "./ChildWorkerProgram.ts";
import { requireChildWorkerLoaderId } from "./ChildWorkerLoaderRecovery.ts";
import { resolveChildWorkerLimits, type ChildWorkerLimits } from "./ChildWorkerLimits.ts";
import {
  disposeWorkerLoaderStubs,
  workerLoaderQuotaFailure,
  type ChildWorkerLoaderPort,
} from "./WorkerLoaderDispatch.ts";

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
  const policy = {
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    globalOutbound: null,
    limits,
  } as const;
  const modulesByHash = new Map(registry);
  for (const [hash, module] of modulesByHash) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !(module instanceof WebAssembly.Module)) {
      throw new TypeError("Expected pinned compiled child WASM modules");
    }
  }
  return {
    async run(input, target) {
      const mainModule = input.mainModule;
      const entrypoint = input.entrypoint;
      let code: {
        readonly compatibilityDate: string;
        readonly compatibilityFlags: readonly string[];
        readonly mainModule: string;
        readonly modules: ReturnType<typeof resolveCompiledChildWorkerModules>;
        readonly globalOutbound: null;
        readonly limits: ReturnType<typeof resolveChildWorkerLimits>;
      };
      let loaderId: string;
      try {
        loaderId = requireChildWorkerLoaderId(input);
        if (
          !input.mainModule ||
          !Object.hasOwn(input.modules, input.mainModule) ||
          (input.entrypoint !== undefined && !/^[a-zA-Z_$][\w$]*$/.test(input.entrypoint))
        )
          throw new TypeError("Invalid child entrypoint");
        if (resolveChildWorkerLimits(input.limits).cpuMs !== limits.cpuMs) {
          throw new RangeError("Child CPU budget differs from the host binding");
        }
        const modules = resolveCompiledChildWorkerModules(input.modules, modulesByHash);
        const main = modules[input.mainModule];
        if (typeof main !== "string" && (main === undefined || !("js" in main))) {
          throw new TypeError("Child main module must contain JavaScript");
        }
        code = { ...policy, mainModule, modules };
      } catch (error) {
        // No loader call happened, so this invocation cannot own a running child.
        const completion = target as typeof target & { stopped(): void | Promise<void> };
        await completion.stopped();
        throw error;
      }
      // Installed workers-types predates compiled-module inputs supported by Worker Loader.
      // https://github.com/cloudflare/workerd/blob/fa8b9d343f00c200b8e8d314c541c33be9e1ee70/src/workerd/api/worker-loader.h#L73-L80
      let worker: ReturnType<WorkerLoader["get"]> | undefined;
      let child: Entrypoint | undefined;
      let outcome:
        | { readonly kind: "exit"; readonly value: KernelCommandExit }
        | { readonly kind: "error"; readonly cause: unknown }
        | undefined;
      const releaseLoaderStubs = () => {
        const entrypoint = child;
        const workerStub = worker;
        child = undefined;
        worker = undefined;
        disposeWorkerLoaderStubs(entrypoint, workerStub);
      };
      try {
        try {
          worker = loader.get(loaderId, () => code as WorkerLoaderWorkerCode);
          child = worker.getEntrypoint<Entrypoint>(entrypoint, { limits }) as unknown as Entrypoint;
        } catch (cause) {
          const quotaFailure = workerLoaderQuotaFailure(cause);
          if (quotaFailure === undefined) throw cause;
          // A rejected Worker Loader acquisition has no child to wait for or retire.
          releaseLoaderStubs();
          const completion = target as typeof target & { stopped(): void | Promise<void> };
          await completion.stopped();
          throw quotaFailure;
        }
        if (child === undefined)
          throw new Error("Child Worker Loader did not create an entrypoint");
        try {
          outcome = { kind: "exit", value: await child.run(input.command, target) };
        } catch (cause) {
          outcome = { kind: "error", cause };
        }
      } finally {
        releaseLoaderStubs();
      }
      if (outcome === undefined) throw new Error("Child Worker Loader returned without an outcome");
      if (outcome.kind === "exit") return outcome.value;
      // The owning dispatch sees the original target; this adapter only owns loader handles.
      throw outcome.cause;
    },
  };
}

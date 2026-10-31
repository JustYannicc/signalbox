import type { WorkerEntrypoint } from "cloudflare:workers";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import { copyKernelRpcRecord } from "../kernel/KernelRpcReply.ts";
import type { ChildWorkerModules } from "./ChildWorkerProgram.ts";
import { requireChildWorkerLoaderId } from "./ChildWorkerLoaderRecovery.ts";
import { resolveChildWorkerLimits, type ChildWorkerLimits } from "./ChildWorkerLimits.ts";
import {
  disposeWorkerLoaderStubs,
  workerLoaderQuotaFailure,
  type ChildWorkerLoaderPort,
} from "./WorkerLoaderDispatch.ts";
import {
  ChildWorkerAssetMaterializationError,
  resolveChildWorkerAssetModules,
  validateChildWorkerModuleNames,
  type ChildWorkerWasmAssetResolver,
} from "./ChildWorkerAssetModules.ts";

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
  validateChildWorkerModuleNames(modules);
  const resolved: CompiledModules = {};
  for (const [name, module] of Object.entries(modules)) {
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

type ResolvedModules = ReturnType<typeof resolveCompiledChildWorkerModules>;

function createChildWorkerLoader(
  loader: WorkerLoader,
  resolveModules: (modules: ChildWorkerModules) => ResolvedModules | Promise<ResolvedModules>,
  materializeOnLoaderMiss: boolean,
  configuredLimits?: ChildWorkerLimits,
): ChildWorkerLoaderPort {
  const limits = resolveChildWorkerLimits(configuredLimits);
  const policy = {
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    globalOutbound: null,
    limits,
  } as const;
  return {
    async run(input, target) {
      const mainModule = input.mainModule;
      const entrypoint = input.entrypoint;
      let loaderId: string;
      let code:
        | {
            readonly compatibilityDate: string;
            readonly compatibilityFlags: readonly string[];
            readonly mainModule: string;
            readonly modules: ReturnType<typeof resolveCompiledChildWorkerModules>;
            readonly globalOutbound: null;
            readonly limits: ReturnType<typeof resolveChildWorkerLimits>;
          }
        | undefined;
      try {
        loaderId = requireChildWorkerLoaderId(input);
        validateChildWorkerModuleNames(input.modules);
        const main = input.modules[mainModule];
        if (
          !input.mainModule ||
          !Object.hasOwn(input.modules, mainModule) ||
          main === undefined ||
          (typeof main !== "string" &&
            !(main !== null && typeof main === "object" && "js" in main)) ||
          (input.entrypoint !== undefined && !/^[a-zA-Z_$][\w$]*$/.test(input.entrypoint))
        )
          throw new TypeError("Invalid child entrypoint");
        if (resolveChildWorkerLimits(input.limits).cpuMs !== limits.cpuMs) {
          throw new RangeError("Child CPU budget differs from the host binding");
        }
        if (!materializeOnLoaderMiss) {
          const modules = await resolveModules(input.modules);
          code = { ...policy, mainModule, modules };
        }
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
      let materializationFailure: ChildWorkerAssetMaterializationError | undefined;
      let materializedCode: Promise<WorkerLoaderWorkerCode> | undefined;
      const getCode = () => {
        if (!materializeOnLoaderMiss) return code as unknown as WorkerLoaderWorkerCode;
        if (materializedCode === undefined) {
          const resolvingCode = Promise.resolve()
            .then(() => resolveModules(input.modules))
            .then(
              (modules) =>
                ({ ...policy, mainModule, modules }) as unknown as WorkerLoaderWorkerCode,
            )
            .catch((cause: unknown) => {
              materializationFailure = new ChildWorkerAssetMaterializationError(cause);
              throw materializationFailure;
            });
          void resolvingCode.catch(() => undefined);
          materializedCode = resolvingCode;
        }
        return materializedCode;
      };
      try {
        try {
          worker = loader.get(loaderId, getCode);
          child = worker.getEntrypoint<Entrypoint>(entrypoint, { limits }) as unknown as Entrypoint;
          // A cache miss can still be materializing after `get` and entrypoint acquisition return.
          // Wait for that callback before asking the child to run.
          if (materializedCode !== undefined) await materializedCode;
        } catch (cause) {
          if (materializationFailure === undefined) {
            const quotaFailure = workerLoaderQuotaFailure(cause);
            if (quotaFailure !== undefined) {
              // A rejected Worker Loader acquisition has no child to wait for or retire.
              releaseLoaderStubs();
              const completion = target as typeof target & { stopped(): void | Promise<void> };
              await completion.stopped();
              throw quotaFailure;
            }
            // Worker Loader can surface acquisition failure before the async code callback settles.
            if (materializedCode !== undefined) {
              try {
                await materializedCode;
              } catch {
                // The callback records its failure so the no-child path can acknowledge it below.
              }
            }
          }
          if (materializationFailure === undefined) throw cause;
        }
        if (child === undefined && materializationFailure === undefined)
          throw new Error("Child Worker Loader did not create an entrypoint");
        if (materializationFailure === undefined) {
          try {
            outcome = {
              kind: "exit",
              value: copyKernelRpcRecord(await child!.run(input.command, target)),
            };
          } catch (cause) {
            if (materializationFailure === undefined) outcome = { kind: "error", cause };
          }
        }
      } finally {
        releaseLoaderStubs();
      }
      if (materializationFailure !== undefined) {
        const completion = target as typeof target & { stopped(): void | Promise<void> };
        await completion.stopped();
        throw materializationFailure.originalCause;
      }
      if (outcome === undefined) throw new Error("Child Worker Loader returned without an outcome");
      if (outcome.kind === "exit") return outcome.value;
      // The owning dispatch sees the original target; this adapter only owns loader handles.
      throw outcome.cause;
    },
  };
}

/** The host chooses the budget and static modules; invocation payloads cannot raise that budget. */
export function createCompiledChildWorkerLoader(
  loader: WorkerLoader,
  registry: CompiledChildWorkerRegistry,
  configuredLimits?: ChildWorkerLimits,
): ChildWorkerLoaderPort {
  const modulesByHash = new Map(registry);
  for (const [hash, module] of modulesByHash) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !(module instanceof WebAssembly.Module)) {
      throw new TypeError("Expected pinned compiled child WASM modules");
    }
  }
  return createChildWorkerLoader(
    loader,
    (modules) => resolveCompiledChildWorkerModules(modules, modulesByHash),
    false,
    configuredLimits,
  );
}

/** Resolve verified Wasm bytes only when Worker Loader first asks for this slot's code. */
export function createAssetChildWorkerLoader(
  loader: WorkerLoader,
  resolveAsset: ChildWorkerWasmAssetResolver,
  configuredLimits?: ChildWorkerLimits,
): ChildWorkerLoaderPort {
  return createChildWorkerLoader(
    loader,
    (modules) => resolveChildWorkerAssetModules(modules, resolveAsset),
    true,
    configuredLimits,
  );
}

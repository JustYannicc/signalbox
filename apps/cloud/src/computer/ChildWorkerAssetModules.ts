import type { ChildWorkerModules } from "./ChildWorkerCode.ts";

export type ChildWorkerWasmAssetResolver = (sha256: string) => Promise<ArrayBuffer | undefined>;

/** Marks a failure before Worker Loader receives any executable child code. */
export class ChildWorkerAssetMaterializationError extends Error {
  readonly originalCause: unknown;

  constructor(cause: unknown) {
    super("Child WASM asset could not be materialized", { cause });
    this.name = "ChildWorkerAssetMaterializationError";
    this.originalCause = cause;
  }
}

export function validateChildWorkerModuleNames(modules: ChildWorkerModules) {
  for (const [name, module] of Object.entries(modules)) {
    if (!name || name.split("/").includes("..")) throw new TypeError("Invalid child module name");
    if (module !== null && typeof module === "object" && "wasmReference" in module) {
      if (typeof module.wasmReference !== "string" || !/^[a-f0-9]{64}$/.test(module.wasmReference))
        throw new TypeError("Invalid child WASM reference");
    }
  }
}

/** Resolve only this invocation's references and verify every byte before Loader sees the module. */
export async function resolveChildWorkerAssetModules(
  modules: ChildWorkerModules,
  resolveAsset: ChildWorkerWasmAssetResolver,
) {
  const resolved: Record<
    string,
    string | { readonly js: string } | { readonly wasm: ArrayBuffer | WebAssembly.Module }
  > = {};
  const assets = new Map<string, Promise<ArrayBuffer>>();
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") {
      Object.defineProperty(resolved, name, { value: module, enumerable: true });
    } else if (module !== null && typeof module === "object" && "wasmReference" in module) {
      const reference = module.wasmReference;
      if (typeof reference !== "string" || !/^[a-f0-9]{64}$/.test(reference))
        throw new TypeError("Invalid child WASM reference");
      let bytes = assets.get(reference);
      if (bytes === undefined) {
        bytes = resolveAsset(reference).then(async (result) => {
          if (!(result instanceof ArrayBuffer)) throw new Error("Unknown child WASM asset");
          const owned = result.slice(0);
          const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned));
          const actual = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
          if (actual !== reference) throw new Error("Child WASM asset hash mismatch");
          return owned;
        });
        assets.set(reference, bytes);
      }
      Object.defineProperty(resolved, name, {
        value: Object.freeze({ wasm: await bytes }),
        enumerable: true,
      });
    } else if (module !== null && typeof module === "object" && "js" in module) {
      if (typeof module.js !== "string") throw new TypeError("Child module source must be text");
      Object.defineProperty(resolved, name, {
        value: Object.freeze({ js: module.js }),
        enumerable: true,
      });
    } else if (
      module !== null &&
      typeof module === "object" &&
      "wasm" in module &&
      (module.wasm instanceof ArrayBuffer || module.wasm instanceof WebAssembly.Module)
    ) {
      Object.defineProperty(resolved, name, {
        value: Object.freeze({ wasm: module.wasm }),
        enumerable: true,
      });
    } else {
      throw new TypeError("Child module must contain JavaScript, WASM bytes, or a WASM reference");
    }
  }
  return Object.freeze(resolved);
}

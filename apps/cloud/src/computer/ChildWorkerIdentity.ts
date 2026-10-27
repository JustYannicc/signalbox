// @effect-diagnostics cryptoRandomUUID:off - opaque compiled modules need an identity when their source bytes are unavailable.
import type { ChildWorkerModules } from "./ChildWorkerCode.ts";
import type { ResolvedChildWorkerLimits } from "./ChildWorkerLimits.ts";

interface ChildWorkerIdentityCode {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly mainModule: string;
  readonly modules: ChildWorkerModules;
  readonly globalOutbound: null;
  readonly limits: ResolvedChildWorkerLimits;
}

// A compiled module exposes no bytes. Reuse that immutable object without conflating different code.
const opaqueModules = new WeakMap<WebAssembly.Module, string>();

/** Only code and loader policy belong in this key. Commands and host capabilities stay per call. */
export async function childWorkerId(
  code: ChildWorkerIdentityCode,
  entrypoint?: string,
  compiledHashes?: ReadonlyMap<WebAssembly.Module, string>,
) {
  const modules = await Promise.all(
    Object.keys(code.modules)
      .sort()
      .map(async (name) => {
        const module = code.modules[name]!;
        if (typeof module === "string") return [name, "source", module];
        if ("wasmReference" in module) return [name, "wasm", module.wasmReference];
        if ("js" in module) return [name, "js", module.js];
        if (module.wasm instanceof ArrayBuffer) {
          return [name, "wasm", await digest(module.wasm)];
        }
        const pinnedHash = compiledHashes?.get(module.wasm);
        if (pinnedHash !== undefined) return [name, "wasm", pinnedHash];
        let identity = opaqueModules.get(module.wasm);
        if (identity === undefined) {
          identity = crypto.randomUUID();
          opaqueModules.set(module.wasm, identity);
        }
        return [name, "compiled-object", identity];
      }),
  );
  const content = JSON.stringify({
    compatibilityDate: code.compatibilityDate,
    compatibilityFlags: code.compatibilityFlags,
    mainModule: code.mainModule,
    entrypoint: entrypoint ?? null,
    modules,
    globalOutbound: code.globalOutbound,
    limits: { cpuMs: code.limits.cpuMs },
  });
  return `child-v1:${await digest(new TextEncoder().encode(content))}`;
}

async function digest(bytes: BufferSource) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

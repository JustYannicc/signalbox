/** WorkerLoader compiles Wasm bytes before the facet imports the module. */
export type HarnessProcessFacetModule =
  | string
  | { readonly js: string }
  | { readonly wasm: ArrayBuffer };

type Modules = Readonly<Record<string, HarnessProcessFacetModule>>;

export function snapshotHarnessProcessModules(
  value: unknown,
  mainModule: string,
): Modules | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const modules: Record<string, HarnessProcessFacetModule> = Object.create(null);
    for (const [name, supplied] of Object.entries(value)) {
      if (name.length === 0 || name.length > 256) return undefined;
      if (typeof supplied === "string") {
        modules[name] = supplied;
        continue;
      }
      if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
        return undefined;
      const keys = Reflect.ownKeys(supplied);
      if (keys.length !== 1) return undefined;
      if (keys[0] === "js" && "js" in supplied && typeof supplied.js === "string") {
        modules[name] = Object.freeze({ js: supplied.js });
      } else if (keys[0] === "wasm" && "wasm" in supplied && supplied.wasm instanceof ArrayBuffer) {
        modules[name] = Object.freeze({ wasm: supplied.wasm.slice(0) });
      } else return undefined;
    }
    const main = modules[mainModule];
    if (main === undefined || (typeof main !== "string" && !("js" in main))) return undefined;
    return Object.freeze(modules);
  } catch {
    return undefined;
  }
}

export function sameHarnessProcessModules(left: Modules, right: Modules): boolean {
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => {
      if (!Object.hasOwn(right, name)) return false;
      const a = left[name];
      const b = right[name];
      if (a === undefined || b === undefined) return false;
      if (typeof a === "string" || typeof b === "string") return a === b;
      if ("js" in a || "js" in b) return "js" in a && "js" in b && a.js === b.js;
      const bytes = new Uint8Array(a.wasm);
      const other = new Uint8Array(b.wasm);
      return bytes.length === other.length && bytes.every((byte, index) => byte === other[index]);
    })
  );
}

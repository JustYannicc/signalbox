import {
  materializePreparedReleaseAsset,
  preparedAssetMatchesRelease,
  samePreparedReleaseAsset,
  snapshotPreparedReleaseAsset,
} from "./preparedReleaseAsset.ts";
import type {
  HarnessProcessPreparedRelease,
  HarnessProcessPreparedReleaseAsset,
  HarnessProcessReleaseAssetChunkReader,
  MaterializedHarnessProcessFacetModule,
} from "./preparedReleaseAsset.ts";

export {
  HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES,
  preparedReleaseAsset,
} from "./preparedReleaseAsset.ts";
export type {
  HarnessProcessPreparedRelease,
  HarnessProcessPreparedReleaseAsset,
} from "./preparedReleaseAsset.ts";

/** WorkerLoader compiles Wasm bytes before the facet imports the module. */
export type HarnessProcessFacetModule =
  | string
  | { readonly js: string }
  | { readonly cjs: string }
  | { readonly text: string }
  | { readonly wasm: ArrayBuffer }
  | { readonly preparedReleaseAsset: HarnessProcessPreparedReleaseAsset };

type Modules = Readonly<Record<string, HarnessProcessFacetModule>>;
type MaterializedModules = Readonly<Record<string, MaterializedHarnessProcessFacetModule>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function assertHarnessProcessModuleAssets(
  modules: Modules,
  release: HarnessProcessPreparedRelease | undefined,
): void {
  for (const module of Object.values(modules)) {
    if (
      typeof module === "string" ||
      "js" in module ||
      "cjs" in module ||
      "text" in module ||
      "wasm" in module
    )
      continue;
    if (!preparedAssetMatchesRelease(module.preparedReleaseAsset, release))
      throw new TypeError("A process facet asset does not match its selected prepared release.");
  }
}

export async function materializeHarnessProcessModules(
  modules: Modules,
  release: HarnessProcessPreparedRelease | undefined,
  readArtifactChunk?: HarnessProcessReleaseAssetChunkReader,
): Promise<MaterializedModules> {
  assertHarnessProcessModuleAssets(modules, release);
  const materialized: Record<string, MaterializedHarnessProcessFacetModule> = Object.create(null);
  for (const [name, module] of Object.entries(modules)) {
    if (
      typeof module === "string" ||
      "js" in module ||
      "cjs" in module ||
      "text" in module ||
      "wasm" in module
    ) {
      materialized[name] = module;
      continue;
    }
    if (readArtifactChunk === undefined)
      throw new TypeError("Prepared release modules need their selected artifact reader.");
    materialized[name] = await materializePreparedReleaseAsset(
      module.preparedReleaseAsset,
      readArtifactChunk,
    );
  }
  return Object.freeze(materialized);
}

export function snapshotHarnessProcessModules(
  value: unknown,
  mainModule: string,
): Modules | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const modules: Record<string, HarnessProcessFacetModule> = Object.create(null);
    for (const [name, supplied] of Object.entries(value)) {
      if (name.length === 0 || name.length > 256) return undefined;
      if (typeof supplied === "string") {
        modules[name] = supplied;
        continue;
      }
      if (!isRecord(supplied)) return undefined;
      const keys = Reflect.ownKeys(supplied);
      if (keys.length !== 1) return undefined;
      if (keys[0] === "js" && "js" in supplied && typeof supplied.js === "string") {
        modules[name] = Object.freeze({ js: supplied.js });
      } else if (keys[0] === "cjs" && "cjs" in supplied && typeof supplied.cjs === "string") {
        modules[name] = Object.freeze({ cjs: supplied.cjs });
      } else if (keys[0] === "text" && "text" in supplied && typeof supplied.text === "string") {
        modules[name] = Object.freeze({ text: supplied.text });
      } else if (keys[0] === "wasm" && "wasm" in supplied && supplied.wasm instanceof ArrayBuffer) {
        modules[name] = Object.freeze({ wasm: supplied.wasm });
      } else if (keys[0] === "preparedReleaseAsset" && "preparedReleaseAsset" in supplied) {
        const asset = snapshotPreparedReleaseAsset(supplied.preparedReleaseAsset);
        if (asset === undefined) return undefined;
        modules[name] = Object.freeze({ preparedReleaseAsset: asset });
      } else return undefined;
    }
    const main = modules[mainModule];
    if (
      main === undefined ||
      (typeof main !== "string" &&
        !("js" in main) &&
        !("cjs" in main) &&
        !(
          "preparedReleaseAsset" in main &&
          main.preparedReleaseAsset.type !== "wasm" &&
          main.preparedReleaseAsset.type !== "text"
        ))
    )
      return undefined;
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
      if ("cjs" in a || "cjs" in b) return "cjs" in a && "cjs" in b && a.cjs === b.cjs;
      if ("text" in a || "text" in b) return "text" in a && "text" in b && a.text === b.text;
      if ("preparedReleaseAsset" in a || "preparedReleaseAsset" in b) {
        return (
          "preparedReleaseAsset" in a &&
          "preparedReleaseAsset" in b &&
          samePreparedReleaseAsset(a.preparedReleaseAsset, b.preparedReleaseAsset)
        );
      }
      const bytes = new Uint8Array(a.wasm);
      const other = new Uint8Array(b.wasm);
      return bytes.length === other.length && bytes.every((byte, index) => byte === other[index]);
    })
  );
}

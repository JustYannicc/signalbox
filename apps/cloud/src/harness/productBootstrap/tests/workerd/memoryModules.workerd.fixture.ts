import type { HarnessProcessExecutionShardInput } from "../../../processPlacement/execution.ts";
import type { HarnessProcessFacetModule } from "../../../HarnessProcessPlacement.ts";
import {
  PRODUCT_FIXTURE_R18_INPUT_CHUNK_BYTES,
  PRODUCT_FIXTURE_R18_INPUT_PATHS,
  type ProductFixtureCapability,
} from "./productCapability.workerd.fixture.ts";

type PreparedRelease = NonNullable<
  HarnessProcessExecutionShardInput["processes"][number]["targetPreparedRelease"]
>;

export async function readR18Inputs(
  capability: Pick<ProductFixtureCapability, "readR18InputChunk">,
  paths: readonly string[] = PRODUCT_FIXTURE_R18_INPUT_PATHS,
) {
  const modules: Record<string, Uint8Array> = Object.create(null);
  for (const path of paths) {
    const first = await capability.readR18InputChunk(path, 0);
    const bytes = new Uint8Array(first.totalBytes);
    for (
      let offset = 0;
      offset < first.totalBytes;
      offset += PRODUCT_FIXTURE_R18_INPUT_CHUNK_BYTES
    ) {
      const chunk = offset === 0 ? first : await capability.readR18InputChunk(path, offset);
      const expectedLength = Math.min(
        PRODUCT_FIXTURE_R18_INPUT_CHUNK_BYTES,
        first.totalBytes - offset,
      );
      if (
        chunk.path !== path ||
        chunk.offset !== offset ||
        chunk.totalBytes !== first.totalBytes ||
        chunk.sha256 !== first.sha256 ||
        chunk.bytes.byteLength !== expectedLength
      )
        throw new Error(`The staged R18 fixture chunk is invalid: ${path} at ${offset}.`);
      bytes.set(chunk.bytes, offset);
    }
    if (!(bytes.buffer instanceof ArrayBuffer))
      throw new Error("The proof needs owned ArrayBuffers.");
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== first.sha256) throw new Error(`The staged R18 fixture is corrupt: ${path}.`);
    modules[path] = bytes;
  }
  return modules;
}

export async function legacyModuleMap(
  source: string,
  release: PreparedRelease,
  raw: Readonly<Record<string, Uint8Array>>,
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const modules: Record<string, HarnessProcessFacetModule> = {
    "productFacet.mjs": { js: source },
  };
  for (const [moduleKey, descriptor] of Object.entries(release.plan.preparedModules)) {
    const rawKey = moduleKey === "codex/worker.js" ? "worker.js" : moduleKey;
    const bytes = raw[rawKey];
    if (
      bytes === undefined ||
      bytes.byteOffset !== 0 ||
      bytes.byteLength !== descriptor.bytes ||
      bytes.byteLength !== bytes.buffer.byteLength
    )
      throw new Error(`The staged R18 module is missing or has the wrong size: ${rawKey}.`);
    if (!(bytes.buffer instanceof ArrayBuffer))
      throw new Error("The proof needs owned ArrayBuffers.");
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== descriptor.sha256)
      throw new Error(`The staged R18 module has the wrong SHA-256: ${rawKey}.`);
    const name = moduleKey === "codex/engine.wasm" ? "codex-engine.wasm" : moduleKey;
    modules[name] =
      descriptor.type === "wasm"
        ? { wasm: bytes.buffer as ArrayBuffer }
        : descriptor.type === "text"
          ? { text: decoder.decode(bytes) }
          : descriptor.type === "cjs"
            ? { cjs: decoder.decode(bytes) }
            : { js: decoder.decode(bytes) };
  }
  modules["r18/codex-Cargo.lock"] = { text: decoder.decode(raw["codex/Cargo.lock"]!) };
  modules["r18/worker.js"] = { js: decoder.decode(raw["worker.js"]!) };
  modules["r18/codex-manifest.json"] = { text: decoder.decode(raw["codex/manifest.json"]!) };
  modules["r18/manifest.json"] = { text: decoder.decode(raw["manifest.json"]!) };
  return Object.freeze(modules);
}

export function copyLegacyModuleSnapshot(
  modules: Readonly<Record<string, HarnessProcessFacetModule>>,
): Readonly<Record<string, HarnessProcessFacetModule>> {
  const snapshot: Record<string, HarnessProcessFacetModule> = Object.create(null);
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") snapshot[name] = module;
    else if ("wasm" in module) snapshot[name] = Object.freeze({ wasm: module.wasm.slice(0) });
    else if ("preparedReleaseAsset" in module)
      throw new TypeError("The legacy memory case cannot retain a release descriptor.");
    else snapshot[name] = module;
  }
  return Object.freeze(snapshot);
}

export const supplementaryMemoryPaths = {
  "r18/codex-Cargo.lock": { path: "codex/Cargo.lock", type: "text" },
  "r18/worker.js": { path: "worker.js", type: "js" },
  "r18/codex-manifest.json": { path: "codex/manifest.json", type: "text" },
  "r18/manifest.json": { path: "manifest.json", type: "text" },
} as const;

export async function supplementaryMemoryModules(
  capability: Pick<ProductFixtureCapability, "readR18InputChunk">,
) {
  const raw = await readR18Inputs(
    capability,
    Object.values(supplementaryMemoryPaths).map((value) => value.path),
  );
  const modules: Record<string, HarnessProcessFacetModule> = Object.create(null);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [name, value] of Object.entries(supplementaryMemoryPaths)) {
    const text = decoder.decode(raw[value.path]!);
    modules[name] = value.type === "js" ? { js: text } : { text };
  }
  return modules;
}

export type MemoryModuleInventory = readonly {
  readonly name: string;
  readonly type: "js" | "cjs" | "text" | "wasm";
  readonly bytes: number;
  readonly sha256: string;
}[];

export async function memoryModuleInventory(
  modules: Readonly<Record<string, HarnessProcessFacetModule>>,
): Promise<MemoryModuleInventory> {
  const rows: Array<MemoryModuleInventory[number]> = [];
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module !== "string" && "preparedReleaseAsset" in module) {
      const asset = module.preparedReleaseAsset;
      rows.push({ name, type: asset.type, bytes: asset.bytes, sha256: asset.sha256 });
      continue;
    }
    const type =
      typeof module === "string" || "js" in module
        ? "js"
        : "wasm" in module
          ? "wasm"
          : "text" in module
            ? "text"
            : "cjs";
    const bytes =
      typeof module === "string"
        ? new TextEncoder().encode(module)
        : "wasm" in module
          ? new Uint8Array(module.wasm)
          : new TextEncoder().encode(
              "js" in module ? module.js : "text" in module ? module.text : module.cjs,
            );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    rows.push({ name, type, bytes: bytes.byteLength, sha256 });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

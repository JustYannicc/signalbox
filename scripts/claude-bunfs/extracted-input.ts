// @effect-diagnostics nodeBuiltinImport:off - build-time verified extractor input.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { decodeModule } from "./bun-graph.ts";

export interface ExtractedArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExtractedModule {
  readonly index: number;
  readonly name: string;
  readonly key?: string;
  readonly loader: number;
  readonly encoding: number;
  readonly format: number;
  readonly artifacts: Readonly<Record<string, ExtractedArtifact>>;
}

export interface ExtractionManifest {
  readonly schemaVersion: number;
  readonly binary: { readonly bytes: number; readonly sha256: string };
  readonly graph: { readonly entry: number; readonly flags: number; readonly recordSize: number };
  readonly modules: ReadonlyArray<ExtractedModule>;
}

export async function readExtraction(root: string) {
  const manifest: ExtractionManifest = JSON.parse(
    await NodeFSP.readFile(NodePath.resolve(root, "manifest.json"), "utf8"),
  );
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules))
    throw new Error("EXTRACTION_SCHEMA_UNSUPPORTED");
  const byName = new Map<string, ExtractedModule>();
  const byKey = new Map<string, ExtractedModule>();
  for (const module of manifest.modules) {
    const key = module.key ?? module.name.replace(/^\/+/, "");
    if (!key || key.startsWith("/") || byName.has(module.name) || byKey.has(key))
      throw new Error(`EXTRACTION_MODULE_ID_INVALID: ${module.name}`);
    byName.set(module.name, module);
    byKey.set(key, module);
  }
  const entry = manifest.modules.find((module) => module.index === manifest.graph.entry);
  if (!entry || entry.loader !== 1) throw new Error("EXTRACTION_ENTRY_NOT_JAVASCRIPT");
  const readContents = async (module: ExtractedModule) => {
    const artifact = module.artifacts.contents;
    if (!artifact) throw new Error(`EXTRACTION_CONTENTS_MISSING: ${module.name}`);
    const path = NodePath.resolve(root, artifact.path);
    const part = NodePath.relative(NodePath.resolve(root), path);
    if (!part || part.startsWith("..") || NodePath.isAbsolute(part))
      throw new Error(`EXTRACTION_PATH_INVALID: ${module.name}`);
    const bytes = await NodeFSP.readFile(path);
    if (
      bytes.byteLength !== artifact.bytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error(`EXTRACTION_HASH_MISMATCH: ${module.name}`);
    return bytes;
  };
  const readSource = async (module: ExtractedModule) => {
    if (module.loader !== 1) throw new Error(`EXTRACTION_NOT_SOURCE: ${module.name}`);
    return decodeModule(await readContents(module), module.encoding);
  };
  return { manifest, entry, byName, byKey, readContents, readSource };
}

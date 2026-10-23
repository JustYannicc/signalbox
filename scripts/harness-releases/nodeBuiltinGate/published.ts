import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { record, sha256, text } from "../guards.ts";
import { freezeArtifact } from "../releaseIdentity.ts";
import { readPublishedOmission } from "./publishedOmission.ts";
import type { BuiltinSource } from "./source.ts";

const invalid = "NODE_BUILTIN_PUBLISHED_MANIFEST_INVALID";

/** Binds scanner inputs to the final published JS and its loader map, after rebundling. */
export async function readPublishedBuiltinSources(directory: string) {
  const root = await NodeFSP.realpath(directory);
  const artifact = await freezeArtifact(root);
  const bytes = await NodeFSP.readFile(NodePath.join(root, "manifest.json"));
  if (sha256(bytes) !== artifact.sha256) throw new Error("NODE_BUILTIN_PUBLISHED_SOURCE_CHANGED");
  const manifest = record(JSON.parse(bytes.toString("utf8")), invalid);
  const omission = readPublishedOmission(manifest.omission);
  const modules = record(manifest.modules, invalid);
  const mapDescriptor = record(manifest.moduleMap, invalid);
  const mapPath = text(mapDescriptor.path, invalid);
  const frozenMap = artifact.files.find((file) => file.path === mapPath);
  if (!frozenMap) throw new Error(invalid);
  const mapBytes = await NodeFSP.readFile(NodePath.join(root, mapPath));
  if (sha256(mapBytes) !== frozenMap.sha256)
    throw new Error("NODE_BUILTIN_PUBLISHED_SOURCE_CHANGED");
  const moduleMap = record(JSON.parse(mapBytes.toString("utf8")), invalid);
  if (Object.keys(moduleMap).length !== Object.keys(modules).length) throw new Error(invalid);

  const sources: BuiltinSource[] = [];
  for (const [name, raw] of Object.entries(modules).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const module = record(raw, invalid);
    const mapped = record(moduleMap[name], invalid);
    if (module.type !== "js" || mapped.type !== module.type || mapped.path !== module.path)
      throw new Error(invalid);
    const path = text(module.path, invalid);
    const frozen = artifact.files.find((file) => file.path === path);
    if (!frozen || frozen.sha256 !== module.sha256 || frozen.bytes !== module.bytes)
      throw new Error(invalid);
    const payload = await NodeFSP.readFile(NodePath.join(root, path));
    if (payload.length !== frozen.bytes || sha256(payload) !== frozen.sha256)
      throw new Error("NODE_BUILTIN_PUBLISHED_SOURCE_CHANGED");
    sources.push({ name, source: new TextDecoder("utf-8", { fatal: true }).decode(payload) });
  }
  if (sources.length === 0 || !Object.hasOwn(modules, text(manifest.mainModule, invalid)))
    throw new Error(invalid);
  return {
    sources,
    artifact,
    partitioned: manifest.workerEntries !== undefined,
    ...(omission === undefined ? {} : { omission }),
  };
}

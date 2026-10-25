// @effect-diagnostics nodeBuiltinImport:off - Pure path handling and Bun-compatible byte decoding.
import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";
import { NodeModuleUnavailableError } from "../isolate/NodeModule.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";

/** Uses the artifact reader's verified bytes, independently of mutable guest files. */
export function createHarnessPreparedAssets(loaded: LoadedHarnessRelease) {
  const assets = new Map<string, { name: string; value: string | undefined }>();
  const referrers = new Map<string, string>();
  for (const asset of loaded.plan.assets) {
    const bytes = loaded.payloads.get(asset.path);
    if (bytes === undefined || bytes.byteLength !== asset.bytes)
      throw new Error("Missing verified prepared asset payload");
    // Match bun-graph-plugin: loader 13 exports text; loader 5 exports its embedded path.
    const value =
      asset.loader === 13
        ? NodeBuffer.Buffer.from(bytes).toString(asset.encoding === 2 ? "utf16le" : "latin1")
        : asset.loader === 5
          ? asset.name
          : undefined;
    const entry = { name: asset.name, value };
    for (const alias of new Set([asset.name, asset.key])) {
      if (assets.has(alias)) throw new Error("Conflicting prepared asset alias");
      assets.set(alias, entry);
    }
  }
  if (loaded.plan.harness === "claude-code") {
    for (const [embedded, key] of Object.entries(loaded.plan.embeddedEntrypoints)) {
      const module = loaded.plan.preparedModules[key];
      if (module === undefined) throw new Error("Missing prepared embedded entrypoint");
      for (const alias of new Set([`/${key}`, `/${module.name}`, `/${module.path}`])) {
        const existing = referrers.get(alias);
        if (existing !== undefined && existing !== embedded)
          throw new Error("Conflicting prepared referrer alias");
        referrers.set(alias, embedded);
      }
    }
  }
  const find = (operation: string, specifier: string, referrer: string) => {
    const name = specifier.startsWith(".")
      ? NodePath.posix.resolve(
          NodePath.posix.dirname(referrers.get(referrer) ?? referrer),
          specifier,
        )
      : specifier;
    const asset = assets.get(name);
    if (asset?.value === undefined) throw new NodeModuleUnavailableError(operation, specifier);
    return asset;
  };
  return {
    prepared: (specifier: string, referrer: string) => find("require", specifier, referrer).value,
    resolvePrepared: (specifier: string, referrer: string) =>
      find("resolve", specifier, referrer).name,
  };
}

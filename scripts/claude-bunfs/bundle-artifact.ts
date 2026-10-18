// @effect-diagnostics nodeBuiltinImport:off - build-time artifact publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface BundleFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface EmbeddedAsset extends BundleFile {
  readonly name: string;
  readonly key: string;
  readonly loader: number;
  readonly encoding: number;
}

export interface BundlePublication {
  readonly output: string;
  readonly release: {
    readonly provider: "claude-code";
    readonly version: string;
    readonly platform: string;
    readonly binarySha256: string;
  };
  readonly mainModule: string;
  readonly mainExport?: "launch";
  readonly embeddedEntrypointExport?: "launch";
  readonly environmentPackageModules?: Readonly<Record<string, string>>;
  readonly embeddedEntrypoints?: Readonly<Record<string, string>>;
  readonly hostEntrypoints?: Readonly<Record<string, string>>;
  readonly modules: ReadonlyArray<BundleFile>;
  readonly assets: ReadonlyArray<EmbeddedAsset>;
  readonly requiredHostModules: ReadonlyArray<string>;
  readonly sourceModules: ReadonlyArray<string>;
  readonly metafile: unknown;
}

const hash = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function relativeFile(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    NodePath.posix.isAbsolute(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`BUNDLE_PATH_INVALID: ${path}`);
  return path;
}

/** Publish a complete immutable directory; a failed build never replaces prior evidence. */
export async function publishBundle(input: BundlePublication) {
  const output = NodePath.resolve(input.output);
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  const stage = await NodeFSP.mkdtemp(`${output}.partial-`);
  try {
    const paths = new Set(["manifest.json", "module-map.json", "metafile.json"]);
    const write = async (file: BundleFile) => {
      const path = relativeFile(file.path);
      if (paths.has(path)) throw new Error(`BUNDLE_PATH_DUPLICATE: ${path}`);
      paths.add(path);
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(stage, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(stage, path), file.contents);
      return { path, bytes: file.contents.byteLength, sha256: hash(file.contents) };
    };
    const modules: Record<string, { path: string; type: "js"; bytes: number; sha256: string }> = {};
    for (const file of [...input.modules].sort((a, b) => a.path.localeCompare(b.path)))
      modules[file.path] = { ...(await write(file)), type: "js" };
    if (!Object.hasOwn(modules, input.mainModule)) throw new Error("BUNDLE_ENTRY_MISSING");
    for (const module of Object.values(input.embeddedEntrypoints ?? {}))
      if (!Object.hasOwn(modules, module))
        throw new Error(`BUNDLE_EMBEDDED_ENTRY_MISSING: ${module}`);
    for (const module of Object.values(input.hostEntrypoints ?? {}))
      if (!Object.hasOwn(modules, module)) throw new Error(`BUNDLE_HOST_ENTRY_MISSING: ${module}`);
    const assets: Record<
      string,
      { path: string; bytes: number; sha256: string; key: string; loader: number; encoding: number }
    > = {};
    for (const asset of [...input.assets].sort((a, b) => a.name.localeCompare(b.name))) {
      if (Object.hasOwn(assets, asset.name))
        throw new Error(`BUNDLE_ASSET_DUPLICATE: ${asset.name}`);
      assets[asset.name] = {
        ...(await write(asset)),
        key: asset.key,
        loader: asset.loader,
        encoding: asset.encoding,
      };
    }
    const moduleMap = Object.fromEntries(
      Object.entries(modules).map(([key, module]) => [
        key,
        { path: module.path, type: module.type },
      ]),
    );
    const mapSource = `${JSON.stringify(moduleMap, null, 2)}\n`;
    const manifest = {
      schemaVersion: 1,
      release: input.release,
      mainModule: input.mainModule,
      ...(input.mainExport ? { mainExport: input.mainExport } : {}),
      ...(input.embeddedEntrypointExport
        ? { embeddedEntrypointExport: input.embeddedEntrypointExport }
        : {}),
      environmentPackageModules: Object.fromEntries(
        Object.entries(input.environmentPackageModules ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, source]) => {
            const contents = new TextEncoder().encode(source);
            return [name, { bytes: contents.byteLength, sha256: hash(contents) }];
          }),
      ),
      embeddedEntrypoints: input.embeddedEntrypoints ?? {},
      hostEntrypoints: input.hostEntrypoints ?? {},
      moduleMap: { path: "module-map.json", sha256: hash(mapSource) },
      modules,
      assets,
      requiredHostModules: [...new Set(input.requiredHostModules)].sort(),
      sourceModules: [...new Set(input.sourceModules)].sort(),
      bytes: Object.values(modules).reduce((total, module) => total + module.bytes, 0),
    };
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    await NodeFSP.writeFile(NodePath.join(stage, "module-map.json"), mapSource);
    await NodeFSP.writeFile(NodePath.join(stage, "manifest.json"), manifestSource);
    await NodeFSP.writeFile(
      NodePath.join(stage, "metafile.json"),
      `${JSON.stringify(input.metafile)}\n`,
    );
    // rename can replace an empty directory, so reject any existing destination explicitly.
    try {
      await NodeFSP.lstat(output);
      throw new Error(`BUNDLE_OUTPUT_EXISTS: ${output}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await NodeFSP.rename(stage, output);
    return { manifest, artifactSha256: hash(manifestSource) };
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

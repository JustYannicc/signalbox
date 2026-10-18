// @effect-diagnostics nodeBuiltinImport:off - validates installed inputs and generated package graphs.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type * as Esbuild from "esbuild";

export function verifyPackage(name: string, entry: string, version: string, license: string): void {
  const manifest = readPackageManifest(name, entry);
  if (manifest.version !== version || manifest.license !== license) {
    throw new Error(
      `[node-environment] expected ${name}@${version} (${license}); found ${String(manifest.version)} (${String(manifest.license)})`,
    );
  }
}

export function assertBundledEntry(
  metafile: Esbuild.Metafile,
  entry: string,
  packageName: string,
  workingDirectory: string,
): void {
  const expected = NodeFS.realpathSync(entry);
  const inputPaths = Object.keys(metafile.inputs).map((path) =>
    realPathOrResolved(path, workingDirectory),
  );
  if (!inputPaths.includes(expected)) {
    throw new Error(`[node-environment] ${packageName} root entry was not bundled from ${entry}`);
  }
}

export function assertOnlyNativeAndWasmImports(
  metafile: Esbuild.Metafile,
  packageName: string,
  expectedWasmImports: ReadonlySet<string>,
): void {
  const builtinNames = new Set(NodeModule.builtinModules.flatMap((name) => [name, `node:${name}`]));
  const externalImports = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external),
  );
  for (const item of externalImports) {
    if (!builtinNames.has(item.path) && !expectedWasmImports.has(item.path)) {
      throw new Error(
        `[node-environment] ${packageName} left an unprepared import external: ${item.path}`,
      );
    }
  }
  for (const importPath of expectedWasmImports) {
    if (externalImports.filter((item) => item.path === importPath).length !== 1) {
      throw new Error(
        `[node-environment] ${packageName} bundle is missing exactly one ${importPath} import`,
      );
    }
  }
}

export function assertWasmSourcesNotBundled(
  metafile: Esbuild.Metafile,
  sourcePaths: readonly string[],
  workingDirectory: string,
): void {
  const inputs = Object.keys(metafile.inputs).map((path) =>
    realPathOrResolved(path, workingDirectory),
  );
  for (const path of sourcePaths) {
    if (inputs.includes(path)) {
      throw new Error(`[node-environment] WASM bytes remained in the JavaScript graph: ${path}`);
    }
  }
}

function readPackageManifest(name: string, entry: string): Record<string, unknown> {
  let directory = NodePath.dirname(NodeFS.realpathSync(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"),
      ) as unknown;
      if (isRecord(manifest) && manifest.name === name) return manifest;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }

    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`[node-environment] could not find ${name} package metadata from ${entry}`);
}

function realPathOrResolved(path: string, workingDirectory: string): string {
  const absolute = NodePath.isAbsolute(path) ? path : NodePath.resolve(workingDirectory, path);
  try {
    return NodeFS.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

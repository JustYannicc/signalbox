// @effect-diagnostics nodeBuiltinImport:off - reads installed package inputs for reproducible bundles.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as Esbuild from "esbuild";

export interface PackageSourceFile {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly path: string;
  readonly sha256: string;
}

export interface PackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseFile: string | null;
  readonly licenseSha256: string | null;
}

export interface PackageInputProvenance {
  readonly packages: readonly PackageLicense[];
  readonly sourceFiles: readonly PackageSourceFile[];
  readonly licenseTexts: readonly string[];
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

interface LocatedPackage {
  readonly root: string;
  readonly manifest: PackageManifest;
}

const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE-MIT",
  "LICENSE-MIT.txt",
] as const;

export function sha256(bytes: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export function inspectPackageInputs(
  metafile: Esbuild.Metafile,
  workingDirectory: string,
): PackageInputProvenance {
  const packages = new Map<string, PackageLicense & { readonly root: string }>();
  const sourceFiles: PackageSourceFile[] = [];

  for (const inputPath of Object.keys(metafile.inputs)) {
    const absolutePath = NodePath.isAbsolute(inputPath)
      ? inputPath
      : NodePath.resolve(workingDirectory, inputPath);
    if (!NodeFS.existsSync(absolutePath) || !NodeFS.statSync(absolutePath).isFile()) continue;
    const sourcePath = NodeFS.realpathSync(absolutePath);
    if (sourcePath.endsWith(".node")) {
      throw new Error(
        `[node-web-environment] native addon entered the package graph: ${inputPath}`,
      );
    }
    const located = locatePackage(sourcePath);
    if (!located) continue;

    const key = `${located.manifest.name}@${located.manifest.version}`;
    if (!packages.has(key)) packages.set(key, inspectPackageLicense(located));
    sourceFiles.push({
      packageName: located.manifest.name,
      packageVersion: located.manifest.version,
      path: NodePath.relative(located.root, sourcePath).split(NodePath.sep).join("/"),
      sha256: sha256(NodeFS.readFileSync(sourcePath)),
    });
  }

  const orderedPackages = [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  const orderedFiles = dedupeSourceFiles(sourceFiles).sort((a, b) =>
    `${a.packageName}@${a.packageVersion}/${a.path}`.localeCompare(
      `${b.packageName}@${b.packageVersion}/${b.path}`,
    ),
  );
  const licenseTexts = orderedPackages.map((license) => {
    const packageInfo = packages.get(`${license.name}@${license.version}`)!;
    const file = packageInfo.licenseFile;
    if (!file) return `SPDX-License-Identifier: ${license.license}`;
    const root = packageInfo.root;
    return NodeFS.readFileSync(NodePath.join(root, file), "utf8").trim();
  });

  return Object.freeze({
    packages: Object.freeze(orderedPackages.map(({ root: _root, ...license }) => license)),
    sourceFiles: Object.freeze(orderedFiles),
    licenseTexts: Object.freeze(licenseTexts),
  });
}

export function inspectLocalSource(path: string, displayPath: string) {
  const bytes = NodeFS.readFileSync(path);
  return Object.freeze({
    path: displayPath,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  });
}

export function packageRoot(entryPath: string): string {
  const located = locatePackage(NodeFS.realpathSync(entryPath));
  if (!located) throw new Error(`[node-web-environment] no package manifest for ${entryPath}`);
  return located.root;
}

export function packageManifest(entryPath: string): PackageManifest {
  const located = locatePackage(NodeFS.realpathSync(entryPath));
  if (!located) throw new Error(`[node-web-environment] no package manifest for ${entryPath}`);
  return located.manifest;
}

export function resolvePackageFile(entryPath: string, member: string): string {
  const root = packageRoot(entryPath);
  const candidate = NodePath.resolve(root, member);
  const relative = NodePath.relative(root, candidate);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new Error(`[node-web-environment] package path escaped its root: ${member}`);
  }
  if (!NodeFS.statSync(candidate).isFile()) {
    throw new Error(`[node-web-environment] package file is missing: ${member}`);
  }
  return NodeFS.realpathSync(candidate);
}

function locatePackage(path: string): LocatedPackage | undefined {
  let directory = NodePath.dirname(path);
  for (;;) {
    const manifestPath = NodePath.join(directory, "package.json");
    try {
      const value: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
      if (isPackageManifest(value)) return { root: directory, manifest: value };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function inspectPackageLicense(
  located: LocatedPackage,
): PackageLicense & { readonly root: string } {
  const licenseFile = LICENSE_FILE_NAMES.find((name) =>
    NodeFS.existsSync(NodePath.join(located.root, name)),
  );
  const licenseBytes = licenseFile
    ? NodeFS.readFileSync(NodePath.join(located.root, licenseFile))
    : undefined;
  return Object.freeze({
    root: located.root,
    name: located.manifest.name,
    version: located.manifest.version,
    license: located.manifest.license,
    licenseFile: licenseFile ?? null,
    licenseSha256: licenseBytes ? sha256(licenseBytes) : null,
  });
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "version") === "string" &&
    typeof Reflect.get(value, "license") === "string"
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

function dedupeSourceFiles(files: readonly PackageSourceFile[]): PackageSourceFile[] {
  const unique = new Map<string, PackageSourceFile>();
  for (const file of files) {
    const key = `${file.packageName}@${file.packageVersion}/${file.path}`;
    const previous = unique.get(key);
    if (previous && previous.sha256 !== file.sha256) {
      throw new Error(`[node-web-environment] package input changed during build: ${key}`);
    }
    unique.set(key, file);
  }
  return [...unique.values()];
}

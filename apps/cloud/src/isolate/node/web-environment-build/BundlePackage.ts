// @effect-diagnostics nodeBuiltinImport:off - bundles installed package source for WorkerLoader.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import { canonicalNodeBuiltin } from "../../NodeBuiltinMap.ts";
import {
  inspectPackageInputs,
  packageManifest,
  resolvePackageFile,
  sha256,
  type PackageInputProvenance,
} from "./PackageProvenance.ts";

export interface PackageBundle {
  readonly source: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly nativeImports: readonly string[];
  readonly inputs: PackageInputProvenance;
}

export interface PackageBundleOptions {
  readonly packageName: "ws" | "node-fetch";
  readonly packageEntry: string;
  readonly expectedVersion: string;
  readonly expectedLicense: string;
  readonly entryMember: string;
  readonly sourcefile: string;
  readonly stdin?: (entryPath: string) => string;
  readonly define?: Readonly<Record<string, string>>;
  /** Actual userland source for legacy core specifiers in the pinned package graph. */
  readonly nodeBuiltinPackageEntries?: Readonly<Record<"punycode" | "node:punycode", string>>;
}

export async function bundleInstalledPackage(
  options: PackageBundleOptions,
): Promise<PackageBundle> {
  const entryPath = resolvePackageFile(options.packageEntry, options.entryMember);
  const manifest = packageManifest(entryPath);
  if (manifest.name !== options.packageName) {
    throw new Error(
      `[node-web-environment] expected package ${options.packageName}; found ${manifest.name}`,
    );
  }
  if (
    manifest.version !== options.expectedVersion ||
    manifest.license !== options.expectedLicense
  ) {
    throw new Error(
      `[node-web-environment] expected ${options.packageName}@${options.expectedVersion} (${options.expectedLicense}); found ${manifest.version} (${manifest.license})`,
    );
  }

  const workingDirectory = NodePath.dirname(entryPath);
  const result = await Esbuild.build({
    absWorkingDir: workingDirectory,
    ...(options.stdin
      ? {
          stdin: {
            contents: options.stdin(entryPath),
            resolveDir: workingDirectory,
            sourcefile: options.sourcefile,
            loader: "js" as const,
          },
        }
      : { entryPoints: [entryPath] }),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "eof",
    ...(options.define ? { define: options.define } : {}),
    plugins: [canonicalBuiltinPlugin(options.nodeBuiltinPackageEntries)],
    metafile: true,
    write: false,
  });
  const source = result.outputFiles?.[0]?.text;
  const metafile = result.metafile;
  if (!source || !metafile) {
    throw new Error(
      `[node-web-environment] ${options.packageName} bundle omitted source or metafile`,
    );
  }
  const nativeImports = assertClosedPackageGraph(metafile, options.packageName);
  const inputs = inspectPackageInputs(metafile, workingDirectory);
  if (!inputs.packages.some((item) => item.name === options.packageName)) {
    throw new Error(`[node-web-environment] ${options.packageName} entry was not bundled`);
  }

  const withLicenses = attachLicenseNotices(source, inputs);
  if (options.packageName === "ws") assertNoOptionalNativeCode(withLicenses);

  return Object.freeze({
    source: withLicenses,
    bytes: Buffer.byteLength(withLicenses),
    sha256: sha256(withLicenses),
    nativeImports,
    inputs,
  });
}

export async function bundleLocalEsm(options: {
  readonly entryPath: string;
  readonly sourcefile: string;
}): Promise<PackageBundle> {
  const result = await Esbuild.build({
    entryPoints: [options.entryPath],
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    minify: true,
    metafile: true,
    write: false,
  });
  const source = result.outputFiles?.[0]?.text;
  const metafile = result.metafile;
  if (!source || !metafile) {
    throw new Error("[node-web-environment] bun:jsc bundle omitted source or metafile");
  }
  const imports = assertClosedPackageGraph(metafile, "bun:jsc");
  if (imports.length !== 0) {
    throw new Error(`[node-web-environment] bun:jsc added unexpected native imports: ${imports}`);
  }
  return Object.freeze({
    source,
    bytes: Buffer.byteLength(source),
    sha256: sha256(source),
    nativeImports: Object.freeze([]),
    inputs: Object.freeze({
      packages: Object.freeze([]),
      sourceFiles: Object.freeze([]),
      licenseTexts: Object.freeze([]),
    }),
  });
}

export function assertClosedPackageGraph(
  metafile: Esbuild.Metafile,
  packageName: string,
): readonly string[] {
  const externalImports = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external).map((item) => item.path),
  );
  const nativeImports = new Set<string>();
  for (const specifier of externalImports) {
    const name = canonicalNodeBuiltin(specifier);
    if (!name || specifier !== `node:${name}`) {
      throw new Error(
        `[node-web-environment] ${packageName} has an unprepared external import: ${specifier}`,
      );
    }
    nativeImports.add(specifier);
  }
  return Object.freeze([...nativeImports].sort());
}

function canonicalBuiltinPlugin(
  nodeBuiltinPackageEntries: PackageBundleOptions["nodeBuiltinPackageEntries"],
): Esbuild.Plugin {
  const builtinNamespace = "signalbox-node-web-environment-builtin";
  return {
    name: "signalbox-node-web-environment-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/, namespace: "file" }, (args) => {
        const userlandEntry =
          nodeBuiltinPackageEntries?.[args.path as "punycode" | "node:punycode"];
        if (userlandEntry) return { path: userlandEntry };
        const name = canonicalNodeBuiltin(args.path);
        if (name) return { path: name, namespace: builtinNamespace };
        if (NodeModule.isBuiltin(args.path)) {
          throw new Error(`[node-web-environment] unsupported Node builtin: ${args.path}`);
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: builtinNamespace }, (args) => ({
        contents: `import builtin from ${JSON.stringify(`node:${args.path}`)};\nmodule.exports = builtin;`,
        loader: "js",
      }));
      build.onResolve({ filter: /.*/, namespace: builtinNamespace }, (args) => {
        const name = canonicalNodeBuiltin(args.path);
        if (!name || args.path !== `node:${name}`) {
          throw new Error(`[node-web-environment] invalid builtin facade import: ${args.path}`);
        }
        return { path: args.path, external: true };
      });
    },
  };
}

function attachLicenseNotices(source: string, inputs: PackageInputProvenance): string {
  const notices = inputs.packages.map((item, index) => {
    const text = inputs.licenseTexts[index] ?? `SPDX-License-Identifier: ${item.license}`;
    const safeText = text.replaceAll("*/", "* /");
    return `/*! ${item.name}@${item.version} (${item.license})\n${safeText}\n*/`;
  });
  return notices.length > 0 ? `${notices.join("\n")}\n${source}` : source;
}

function assertNoOptionalNativeCode(source: string): void {
  for (const name of ["bufferutil", "utf-8-validate"]) {
    if (source.includes(name)) {
      throw new Error(`[node-web-environment] ws retained optional native dependency ${name}`);
    }
  }
}

import * as NodeCrypto from "node:crypto";
import * as Esbuild from "esbuild";

export interface PackageLicensePin {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseFile: string | null;
  readonly licenseSha256: string | null;
}

export interface PackageSourcePin {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ClaudeNodeWebModuleProvenance {
  readonly specifier: "ws" | "node-fetch" | "bun:jsc";
  readonly entryPath: string;
  readonly packageVersion: string;
  readonly license: string | null;
  readonly packageClosure: ReadonlyArray<PackageLicensePin>;
  readonly sourceFiles: ReadonlyArray<PackageSourcePin>;
  readonly nativeImports: ReadonlyArray<string>;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly rawOutputBytes: number;
  readonly rawOutputSha256: string;
  readonly reboundNativeImports: ReadonlyArray<string>;
  readonly buildDefines: Readonly<Record<string, boolean>>;
}

export interface ClaudeRuntimeInputProvenance {
  readonly nodeWebEnvironment: {
    readonly schemaVersion: 1;
    readonly moduleMapBytes: number;
    readonly moduleMapSha256: string;
    readonly modules: Readonly<Record<string, ClaudeNodeWebModuleProvenance>>;
  };
  readonly nodeBuiltinRoutes: { readonly count: number; readonly sha256: string };
  readonly nodeBridgeFacades: { readonly count: number; readonly sha256: string };
  readonly packageMapRebinding: {
    readonly bundler: "esbuild";
    readonly bundlerVersion: string;
    readonly boundNativeImports: Readonly<Record<string, ReadonlyArray<string>>>;
  };
  readonly r5Diagnostic: {
    readonly routesSha256: string;
    readonly routesMatch: boolean;
    readonly facadeCount: number;
    readonly facadeCountMatch: boolean;
    readonly packageMapBytes: number;
    readonly packageMapSha256: string;
    readonly packageMapMatch: boolean;
  };
}

export interface ClaudeRuntimeBuildInputs {
  readonly layerModules: Readonly<Record<string, string>>;
  readonly environmentPackageModules: Readonly<Record<"ws" | "node-fetch" | "bun:jsc", string>>;
  readonly requireBootstrap: string;
  readonly nodeBuiltinModules: ReadonlyArray<string>;
  readonly bunApis: Readonly<Record<string, string>>;
  readonly provenance: ClaudeRuntimeInputProvenance;
}

export const runtimeInputDigest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export function runtimeInputJsonString(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function runtimePackageMapSource(value: Readonly<Record<string, string>>): string {
  return `${JSON.stringify(value)}\n`;
}

export function sortedRuntimeModules(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function expectedRuntimeModuleKeys(routes: ReadonlyArray<string>): string[] {
  return routes.flatMap((name) => [name, `node:${name}`]).sort((a, b) => a.localeCompare(b));
}

export function assertClaudeRuntimeInputs(inputs: ClaudeRuntimeBuildInputs): void {
  const modules = sortedRuntimeModules(inputs.layerModules);
  const packageModules = inputs.environmentPackageModules;
  const serializedPackageMap = runtimePackageMapSource(packageModules);
  const expectedLayerHash = runtimeInputDigest(runtimeInputJsonString(modules));
  if (
    Object.keys(inputs.layerModules).length !== inputs.provenance.nodeBridgeFacades.count ||
    expectedLayerHash !== inputs.provenance.nodeBridgeFacades.sha256
  )
    throw new Error("CLAUDE_NODE_BRIDGE_FACADE_PROVENANCE_MISMATCH");
  if (
    Object.keys(packageModules).join("\0") !== "ws\0node-fetch\0bun:jsc" ||
    runtimeInputDigest(serializedPackageMap) !==
      inputs.provenance.nodeWebEnvironment.moduleMapSha256 ||
    Buffer.byteLength(serializedPackageMap) !== inputs.provenance.nodeWebEnvironment.moduleMapBytes
  )
    throw new Error("CLAUDE_ENVIRONMENT_PACKAGE_PROVENANCE_MISMATCH");
  for (const [specifier, source] of Object.entries(packageModules)) {
    const module = inputs.provenance.nodeWebEnvironment.modules[specifier];
    if (typeof source !== "string" || !module || runtimeInputDigest(source) !== module.outputSha256)
      throw new Error(`CLAUDE_ENVIRONMENT_PACKAGE_SOURCE_MISMATCH: ${specifier}`);
    if (
      module.outputBytes !== Buffer.byteLength(source) ||
      !/^[a-f0-9]{64}$/u.test(module.rawOutputSha256) ||
      !Number.isSafeInteger(module.rawOutputBytes) ||
      module.rawOutputBytes <= 0 ||
      JSON.stringify(module.reboundNativeImports) !==
        JSON.stringify(inputs.provenance.packageMapRebinding.boundNativeImports[specifier])
    )
      throw new Error(`CLAUDE_ENVIRONMENT_PACKAGE_PROVENANCE_MISMATCH: ${specifier}`);
    for (const nativeImport of module.nativeImports)
      if (
        !Object.hasOwn(inputs.layerModules, nativeImport.replace(/^node:/u, "")) ||
        !module.reboundNativeImports.includes(nativeImport)
      )
        throw new Error(`CLAUDE_NODE_BRIDGE_BUILTIN_UNROUTED: ${nativeImport}`);
    for (const dependency of module.packageClosure)
      if (!dependency.name || !dependency.version || !dependency.license)
        throw new Error(`CLAUDE_ENVIRONMENT_PACKAGE_LICENSE_MISSING: ${specifier}`);
  }
  const nativeImports = Object.values(inputs.provenance.nodeWebEnvironment.modules).flatMap(
    (module) => module.nativeImports,
  );
  for (const name of nativeImports)
    if (!Object.hasOwn(inputs.layerModules, name))
      throw new Error(`CLAUDE_NODE_BRIDGE_BUILTIN_UNROUTED: ${name}`);
  if (
    !inputs.requireBootstrap.includes(
      ".require('node:module').createRequire('/signalbox/claude.js')",
    )
  )
    throw new Error("CLAUDE_REQUIRE_BOOTSTRAP_INVALID");
  if (
    inputs.provenance.packageMapRebinding.bundler !== "esbuild" ||
    inputs.provenance.packageMapRebinding.bundlerVersion !== Esbuild.version ||
    Object.keys(inputs.provenance.packageMapRebinding.boundNativeImports).sort().join("\0") !==
      "bun:jsc\0node-fetch\0ws"
  )
    throw new Error("CLAUDE_PACKAGE_REBINDING_PROVENANCE_INVALID");
}

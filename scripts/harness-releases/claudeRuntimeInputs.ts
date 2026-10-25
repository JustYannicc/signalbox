import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { digest, record as asRecord, text as asText } from "./guards.ts";
import { rebindClaudePackageImports } from "./claudePackageRebinding.ts";
import {
  expectedRuntimeModuleKeys,
  runtimeInputDigest,
  runtimeInputJsonString,
  runtimePackageMapSource,
  sortedRuntimeModules,
  type ClaudeNodeWebModuleProvenance,
  type ClaudeRuntimeBuildInputs,
  type ClaudeRuntimeInputProvenance,
} from "./claudeRuntimeInputProof.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const ACCEPTED_R5_DIAGNOSTIC = Object.freeze({
  routesSha256: "7fdf097dce91544e94d4feb899478a2f96763191b390039a8e2cbd6a195f0948",
  facadeCount: 86,
  packageMapBytes: 976859,
  packageMapSha256: "4b675ee0fb24b9cd9062faa575082f64a6685cbd480b3d549581239dc11d766f",
});

const record = (value: unknown) => asRecord(value, "CLAUDE_INPUT_OBJECT_REQUIRED");
const text = (value: unknown, code: string) => asText(value, code);

function stringList(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(code);
  return [...value];
}

function stringRecord(value: unknown, code: string): Record<string, string> {
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.some(([name, item]) => !name || typeof item !== "string")) throw new Error(code);
  return Object.fromEntries(entries) as Record<string, string>;
}

function booleanRecord(value: unknown, code: string): Record<string, boolean> {
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.some(([name, item]) => !name || typeof item !== "boolean")) throw new Error(code);
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null) return null;
  return text(value, code);
}

function positiveBytes(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(code);
  return value;
}

function parseClaudeNodeWebModule(
  value: unknown,
  expectedSpecifier: "ws" | "node-fetch" | "bun:jsc",
): ClaudeNodeWebModuleProvenance {
  const input = record(value);
  const code = "CLAUDE_PACKAGE_PROVENANCE_INVALID";
  if (input.specifier !== expectedSpecifier) throw new Error(code);
  const packageClosure = input.packageClosure;
  const sourceFiles = input.sourceFiles;
  if (!Array.isArray(packageClosure) || !Array.isArray(sourceFiles)) throw new Error(code);
  const outputBytes = positiveBytes(input.outputBytes, code);
  const outputSha256 = digest(input.outputSha256, code);
  const nativeImports = stringList(input.nativeImports, code);
  return {
    specifier: expectedSpecifier,
    entryPath: text(input.entryPath, code),
    packageVersion: text(input.packageVersion, code),
    license: nullableText(input.license, code),
    packageClosure: packageClosure.map((value) => {
      const item = record(value);
      const licenseSha256 = item.licenseSha256;
      return {
        name: text(item.name, code),
        version: text(item.version, code),
        license: text(item.license, code),
        licenseFile: nullableText(item.licenseFile, code),
        licenseSha256: licenseSha256 === null ? null : digest(licenseSha256, code),
      };
    }),
    sourceFiles: sourceFiles.map((value) => {
      const item = record(value);
      return {
        packageName: text(item.packageName, code),
        packageVersion: text(item.packageVersion, code),
        path: text(item.path, code),
        sha256: digest(item.sha256, code),
      };
    }),
    nativeImports,
    outputBytes,
    outputSha256,
    rawOutputBytes:
      input.rawOutputBytes === undefined ? outputBytes : positiveBytes(input.rawOutputBytes, code),
    rawOutputSha256:
      input.rawOutputSha256 === undefined ? outputSha256 : digest(input.rawOutputSha256, code),
    reboundNativeImports:
      input.reboundNativeImports === undefined
        ? nativeImports
        : stringList(input.reboundNativeImports, code),
    buildDefines: booleanRecord(input.buildDefines, code),
  };
}

/** Parse the child process result before using package provenance or hashes. */
export function decodeClaudeNodeWebEnvironment(
  value: unknown,
): ClaudeRuntimeInputProvenance["nodeWebEnvironment"] {
  const input = record(value);
  const modules = record(input.modules);
  const specifiers = ["ws", "node-fetch", "bun:jsc"] as const;
  if (
    input.schemaVersion !== 1 ||
    typeof input.moduleMapBytes !== "number" ||
    !Number.isSafeInteger(input.moduleMapBytes) ||
    input.moduleMapBytes <= 0 ||
    Object.keys(modules).sort().join("\0") !== [...specifiers].sort().join("\0")
  )
    throw new Error("CLAUDE_NODE_WEB_ENVIRONMENT_INVALID");
  return {
    schemaVersion: 1,
    moduleMapBytes: input.moduleMapBytes,
    moduleMapSha256: digest(input.moduleMapSha256, "CLAUDE_NODE_WEB_ENVIRONMENT_INVALID"),
    modules: Object.fromEntries(
      specifiers.map((specifier) => [
        specifier,
        parseClaudeNodeWebModule(modules[specifier], specifier),
      ]),
    ),
  };
}

async function generateRuntimeInputs(repository: string) {
  const source = (path: string) => NodePath.join(repository, path);
  const urls = {
    web: NodeURL.pathToFileURL(source("apps/cloud/src/isolate/NodeWebEnvironmentBuild.ts")).href,
    bridge: NodeURL.pathToFileURL(source("apps/cloud/src/isolate/NodeBridge.ts")).href,
    builtins: NodeURL.pathToFileURL(source("apps/cloud/src/isolate/NodeBuiltinMap.ts")).href,
    bun: NodeURL.pathToFileURL(source("apps/cloud/src/isolate/bun/capabilities.ts")).href,
  };
  const script = `
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const [web, bridge, builtins, bun] = await Promise.all([
  import(${JSON.stringify(urls.web)}),
  import(${JSON.stringify(urls.bridge)}),
  import(${JSON.stringify(urls.builtins)}),
  import(${JSON.stringify(urls.bun)}),
]);
const require = createRequire(${JSON.stringify(NodePath.join(repository, "apps/cloud/package.json"))});
const environment = await web.buildNodeWebEnvironment({ws: require.resolve("ws"), "node-fetch": require.resolve("node-fetch")});
const routes = Object.keys(builtins.NODE_BUILTIN_ROUTES);
const layerModules = bridge.createNodeBridgeLayerModules(routes);
const routesSha256 = createHash("sha256").update(JSON.stringify(builtins.NODE_BUILTIN_ROUTES)).digest("hex");
process.stdout.write(JSON.stringify({
  routes,
  routesSha256,
  layerModules,
  environmentPackageModules: environment.environmentPackageModules,
  environmentProvenance: environment.provenance,
  nativeImports: environment.nativeImports,
  bunApis: bun.BUN_API_CAPABILITIES,
}));
`;
  const { stdout } = await execFile(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: repository, maxBuffer: 32 * 1024 * 1024 },
  );
  return record(JSON.parse(stdout));
}

export async function createClaudeRuntimeInputs(
  repository: string,
): Promise<ClaudeRuntimeBuildInputs> {
  const generated = await generateRuntimeInputs(repository);
  const routes = generated.routes;
  if (!Array.isArray(routes) || routes.some((name) => typeof name !== "string"))
    throw new Error("CLAUDE_NODE_BUILTIN_ROUTES_INVALID");
  const layerModules = stringRecord(generated.layerModules, "CLAUDE_NODE_BRIDGE_MODULES_INVALID");
  const rawEnvironmentPackageModules = stringRecord(
    generated.environmentPackageModules,
    "CLAUDE_ENVIRONMENT_PACKAGE_MODULES_INVALID",
  );
  const nodeWebEnvironment = decodeClaudeNodeWebEnvironment(generated.environmentProvenance);
  const nativeImports = generated.nativeImports;
  if (!Array.isArray(nativeImports) || nativeImports.some((name) => typeof name !== "string"))
    throw new Error("CLAUDE_PACKAGE_NATIVE_IMPORTS_INVALID");
  const sortedRoutes = [...routes].sort((a, b) => a.localeCompare(b));
  const expectedFacadeKeys = expectedRuntimeModuleKeys(sortedRoutes);
  if (JSON.stringify(Object.keys(layerModules).sort()) !== JSON.stringify(expectedFacadeKeys))
    throw new Error("CLAUDE_NODE_BRIDGE_FACADE_SET_MISMATCH");
  for (const moduleName of nativeImports)
    if (!Object.hasOwn(layerModules, moduleName))
      throw new Error(`CLAUDE_NODE_BRIDGE_BUILTIN_UNROUTED: ${moduleName}`);
  const packageNames = Object.keys(rawEnvironmentPackageModules).sort();
  if (JSON.stringify(packageNames) !== JSON.stringify(["bun:jsc", "node-fetch", "ws"]))
    throw new Error("CLAUDE_ENVIRONMENT_PACKAGE_SET_MISMATCH");
  const rawModuleMap = `${JSON.stringify(rawEnvironmentPackageModules, null, 2)}\n`;
  if (
    nodeWebEnvironment.moduleMapBytes !== Buffer.byteLength(rawModuleMap) ||
    nodeWebEnvironment.moduleMapSha256 !== runtimeInputDigest(rawModuleMap)
  )
    throw new Error("CLAUDE_RAW_PACKAGE_MAP_PROVENANCE_MISMATCH");
  const rawModuleProvenance = {} as Record<
    "ws" | "node-fetch" | "bun:jsc",
    ClaudeNodeWebModuleProvenance
  >;
  const environmentPackageModules = {} as Record<"ws" | "node-fetch" | "bun:jsc", string>;
  const boundNativeImports: Record<string, ReadonlyArray<string>> = {};
  for (const specifier of ["ws", "node-fetch", "bun:jsc"] as const) {
    const rawModule = rawEnvironmentPackageModules[specifier];
    if (typeof rawModule !== "string")
      throw new Error(`CLAUDE_ENVIRONMENT_PACKAGE_MISSING: ${specifier}`);
    const metadata = nodeWebEnvironment.modules[specifier];
    if (!metadata) throw new Error(`CLAUDE_PACKAGE_PROVENANCE_MISSING: ${specifier}`);
    const rebound = await rebindClaudePackageImports(
      specifier,
      rawModule,
      metadata.nativeImports,
      layerModules,
    );
    environmentPackageModules[specifier] = rebound.source;
    boundNativeImports[specifier] = rebound.nativeImports;
    rawModuleProvenance[specifier] = {
      ...metadata,
      rawOutputBytes: metadata.outputBytes,
      rawOutputSha256: metadata.outputSha256,
      outputBytes: Buffer.byteLength(rebound.source),
      outputSha256: runtimeInputDigest(rebound.source),
      reboundNativeImports: rebound.nativeImports,
    };
  }
  const reboundMapSource = runtimePackageMapSource(environmentPackageModules);
  const finalEnvironmentProvenance: ClaudeRuntimeInputProvenance["nodeWebEnvironment"] = {
    ...nodeWebEnvironment,
    moduleMapBytes: Buffer.byteLength(reboundMapSource),
    moduleMapSha256: runtimeInputDigest(reboundMapSource),
    modules: rawModuleProvenance,
  };
  const registryLiteral = Object.values(layerModules)[0]?.match(
    /Symbol\.for\(("(?:[^"\\]|\\.)*")\)/u,
  )?.[1];
  if (!registryLiteral) throw new Error("CLAUDE_NODE_BRIDGE_REGISTRY_MISSING");
  const registryName: unknown = JSON.parse(registryLiteral);
  if (typeof registryName !== "string" || !registryName)
    throw new Error("CLAUDE_NODE_BRIDGE_REGISTRY_INVALID");
  const requireBootstrap = `globalThis[Symbol.for(${JSON.stringify(registryName)})].require('node:module').createRequire('/signalbox/claude.js')`;
  const routesSha256 = digest(generated.routesSha256, "CLAUDE_NODE_BUILTIN_ROUTES_HASH_MISSING");
  const facadeDigest = runtimeInputDigest(
    runtimeInputJsonString(sortedRuntimeModules(layerModules)),
  );
  const packageMapBytes = Buffer.byteLength(reboundMapSource);
  const packageMapSha256 = runtimeInputDigest(reboundMapSource);
  if (
    finalEnvironmentProvenance.moduleMapBytes !== packageMapBytes ||
    finalEnvironmentProvenance.moduleMapSha256 !== packageMapSha256
  )
    throw new Error("CLAUDE_ENVIRONMENT_PACKAGE_PROVENANCE_MISMATCH");
  const bunApis = stringRecord(generated.bunApis, "CLAUDE_BUN_API_CAPABILITIES_INVALID");
  const provenance: ClaudeRuntimeInputProvenance = {
    nodeWebEnvironment: finalEnvironmentProvenance,
    nodeBuiltinRoutes: { count: routes.length, sha256: routesSha256 },
    nodeBridgeFacades: { count: Object.keys(layerModules).length, sha256: facadeDigest },
    packageMapRebinding: {
      bundler: "esbuild",
      bundlerVersion: Esbuild.version,
      boundNativeImports,
    },
    r5Diagnostic: {
      routesSha256: ACCEPTED_R5_DIAGNOSTIC.routesSha256,
      routesMatch: routesSha256 === ACCEPTED_R5_DIAGNOSTIC.routesSha256,
      facadeCount: ACCEPTED_R5_DIAGNOSTIC.facadeCount,
      facadeCountMatch: Object.keys(layerModules).length === ACCEPTED_R5_DIAGNOSTIC.facadeCount,
      packageMapBytes,
      packageMapSha256,
      packageMapMatch:
        packageMapBytes === ACCEPTED_R5_DIAGNOSTIC.packageMapBytes &&
        packageMapSha256 === ACCEPTED_R5_DIAGNOSTIC.packageMapSha256,
    },
  };
  const inputs: ClaudeRuntimeBuildInputs = {
    layerModules,
    environmentPackageModules,
    requireBootstrap,
    nodeBuiltinModules: sortedRoutes,
    bunApis,
    provenance,
  };
  return inputs;
}

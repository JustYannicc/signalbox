// @effect-diagnostics nodeBuiltinImport:off - prepares installed JS packages for the WorkerLoader graph.
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  bundleInstalledPackage,
  bundleLocalEsm,
} from "./node/web-environment-build/BundlePackage.ts";
import {
  inspectLocalSource,
  packageManifest,
  packageRoot,
  resolvePackageFile,
  sha256,
  type PackageLicense,
  type PackageSourceFile,
} from "./node/web-environment-build/PackageProvenance.ts";

export type NodeWebEnvironmentPackageName = "ws" | "node-fetch" | "bun:jsc";
export type NodeWebEnvironmentPackageModules = Readonly<
  Record<NodeWebEnvironmentPackageName, string>
>;

export const NODE_WEB_ENVIRONMENT_PACKAGE_REQUIREMENTS = Object.freeze({
  ws: Object.freeze({ version: "8.22.0", license: "MIT" }),
  "node-fetch": Object.freeze({ version: "2.7.0", license: "MIT" }),
  punycode: Object.freeze({ version: "2.3.1", license: "MIT" }),
});

export interface NodeWebEnvironmentPackageEntryPaths {
  readonly ws: string;
  readonly "node-fetch": string;
}

export interface NodeWebEnvironmentModuleProvenance {
  readonly specifier: NodeWebEnvironmentPackageName;
  readonly entryPath: string;
  readonly packageVersion: string;
  readonly license: string | null;
  readonly packageClosure: readonly PackageLicense[];
  readonly sourceFiles: readonly PackageSourceFile[];
  readonly nativeImports: readonly string[];
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly buildDefines: Readonly<Record<string, boolean>>;
}

export interface NodeWebEnvironmentBuildProvenance {
  readonly schemaVersion: 1;
  readonly moduleMapBytes: number;
  readonly moduleMapSha256: string;
  readonly modules: Readonly<Record<NodeWebEnvironmentPackageName, NodeWebEnvironmentModuleProvenance>>;
}

export interface NodeWebEnvironmentBuild {
  /** Exact package source strings accepted by the generic environmentPackageModules pipeline. */
  readonly environmentPackageModules: NodeWebEnvironmentPackageModules;
  readonly nativeImports: readonly string[];
  readonly provenance: NodeWebEnvironmentBuildProvenance;
}

/** Bundle the pinned installed packages while keeping canonical Node builtins external. */
export async function buildNodeWebEnvironment(
  packageEntries: NodeWebEnvironmentPackageEntryPaths,
): Promise<NodeWebEnvironmentBuild> {
  const wsRequirement = NODE_WEB_ENVIRONMENT_PACKAGE_REQUIREMENTS.ws;
  const fetchRequirement = NODE_WEB_ENVIRONMENT_PACKAGE_REQUIREMENTS["node-fetch"];
  const wsImportEntry = resolveImportEntry(packageEntries.ws);
  const wsEntryPath = resolvePackageFile(
    packageEntries.ws,
    getPackageMain(packageEntries.ws),
  );
  const punycodeEntry = resolvePunycodeEntry();
  const fetchManifest = packageManifest(packageEntries["node-fetch"]);
  if (typeof fetchManifest === "undefined") {
    throw new Error("[node-web-environment] node-fetch package metadata is missing");
  }
  const fetchMain = resolvePackageFile(
    packageEntries["node-fetch"],
    getPackageMain(packageEntries["node-fetch"]),
  );

  const ws = await bundleInstalledPackage({
    packageName: "ws",
    packageEntry: packageEntries.ws,
    expectedVersion: wsRequirement.version,
    expectedLicense: wsRequirement.license,
    entryMember: NodePath.relative(packageRoot(packageEntries.ws), wsEntryPath),
    sourcefile: "node-web-environment-ws.mjs",
    // ws's CJS root owns its static aliases; expose those same values as ESM named exports.
    stdin: (entryPath) => [
      `import WebSocketEsm, {
  WebSocket as NamedWebSocket,
  WebSocketServer,
  createWebSocketStream,
  extension,
  PerMessageDeflate,
  Receiver,
  Sender,
  subprotocol,
} from ${JSON.stringify(wsImportEntry)};`,
      `const WebSocketModule = require(${JSON.stringify(entryPath)});`,
      'if (WebSocketEsm !== WebSocketModule) throw new Error("ws ESM and CJS roots differ");',
      "export default WebSocketModule;",
      "export const WebSocket = NamedWebSocket;",
      "export { WebSocketServer, createWebSocketStream, extension, PerMessageDeflate, Receiver, Sender, subprotocol };",
    ].join("\n"),
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "true",
      "process.env.WS_NO_UTF_8_VALIDATE": "true",
    },
  });
  const fetch = await bundleInstalledPackage({
    packageName: "node-fetch",
    packageEntry: packageEntries["node-fetch"],
    expectedVersion: fetchRequirement.version,
    expectedLicense: fetchRequirement.license,
    entryMember: NodePath.relative(packageRoot(packageEntries["node-fetch"]), fetchMain),
    sourcefile: "node-web-environment-node-fetch.mjs",
    nodeBuiltinPackageEntries: {
      punycode: punycodeEntry,
      "node:punycode": punycodeEntry,
    },
    stdin: (entryPath) => [
      `import fetch from ${JSON.stringify(entryPath)};`,
      "export default fetch;",
      "export const AbortError = fetch.AbortError;",
      "export const FetchError = fetch.FetchError;",
      "export const Headers = fetch.Headers;",
      "export const Request = fetch.Request;",
      "export const Response = fetch.Response;",
    ].join("\n"),
  });

  const bunJscPath = NodeURL.fileURLToPath(new URL("./NodeBunJsc.ts", import.meta.url));
  const bunJsc = await bundleLocalEsm({ entryPath: bunJscPath, sourcefile: "NodeBunJsc.ts" });
  if (!bunJsc.source.includes("ERR_BUN_JSC_UNAVAILABLE")) {
    throw new Error("[node-web-environment] bun:jsc bundle omitted its typed unsupported error");
  }

  const environmentPackageModules = Object.freeze({
    ws: ws.source,
    "node-fetch": fetch.source,
    "bun:jsc": bunJsc.source,
  });
  const serializedMap = serializeNodeWebEnvironmentPackageModules(environmentPackageModules);
  const bunJscInput = inspectLocalSource(bunJscPath, "apps/cloud/src/isolate/NodeBunJsc.ts");
  const modules = Object.freeze({
    ws: packageProvenance(
      "ws",
      NodePath.relative(packageRoot(packageEntries.ws), wsEntryPath).split(NodePath.sep).join("/"),
      ws,
    ),
    "node-fetch": packageProvenance("node-fetch", "lib/index.js", fetch),
    "bun:jsc": Object.freeze({
      specifier: "bun:jsc" as const,
      entryPath: bunJscInput.path,
      packageVersion: "workspace-source",
      license: null,
      packageClosure: Object.freeze([]),
      sourceFiles: Object.freeze([
        Object.freeze({
          packageName: "@signalbox/cloud",
          packageVersion: "workspace-source",
          path: bunJscInput.path,
          sha256: bunJscInput.sha256,
        }),
      ]),
      nativeImports: bunJsc.nativeImports,
      outputBytes: bunJsc.bytes,
      outputSha256: bunJsc.sha256,
      buildDefines: Object.freeze({}),
    }),
  });
  const nativeImports = Object.freeze(
    [...new Set([...ws.nativeImports, ...fetch.nativeImports])].sort(),
  );
  return Object.freeze({
    environmentPackageModules,
    nativeImports,
    provenance: Object.freeze({
      schemaVersion: 1 as const,
      moduleMapBytes: NodeBuffer.Buffer.byteLength(serializedMap),
      moduleMapSha256: sha256(serializedMap),
      modules,
    }),
  });
}

export function serializeNodeWebEnvironmentPackageModules(
  modules: NodeWebEnvironmentPackageModules,
): string {
  return `${JSON.stringify(modules, null, 2)}\n`;
}

function getPackageMain(packageEntry: string): string {
  const manifestPath = NodePath.join(packageRoot(packageEntry), "package.json");
  const manifest: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (!isRecord(manifest)) {
    throw new Error("[node-web-environment] node-fetch does not declare its CJS main entry");
  }
  const rootExports = Reflect.get(manifest, "exports");
  const root = isRecord(rootExports) ? Reflect.get(rootExports, ".") : undefined;
  const requireTarget = isRecord(root) ? Reflect.get(root, "require") : undefined;
  if (typeof requireTarget === "string" && requireTarget.startsWith("./")) {
    return requireTarget.slice(2);
  }
  const main = Reflect.get(manifest, "main");
  if (typeof main !== "string") {
    throw new Error("[node-web-environment] package does not declare its CJS main entry");
  }
  return main;
}

function resolveImportEntry(packageEntry: string): string {
  const manifestPath = NodePath.join(packageRoot(packageEntry), "package.json");
  const manifest: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const rootExports = isRecord(manifest) ? Reflect.get(manifest, "exports") : undefined;
  const packageRootExports = isRecord(rootExports) ? Reflect.get(rootExports, ".") : undefined;
  const importTarget = isRecord(packageRootExports) ? Reflect.get(packageRootExports, "import") : undefined;
  if (typeof importTarget !== "string" || !importTarget.startsWith("./")) {
    throw new Error("[node-web-environment] ws does not declare an ESM import entry");
  }
  return resolvePackageFile(packageEntry, importTarget.slice(2));
}

function resolvePunycodeEntry(): string {
  // Punycode.js documents the trailing slash as the way to select npm userland over Node core.
  const entry = NodeModule.createRequire(import.meta.url).resolve("punycode/");
  const manifest = packageManifest(entry);
  const requirement = NODE_WEB_ENVIRONMENT_PACKAGE_REQUIREMENTS.punycode;
  if (manifest.name !== "punycode" || manifest.version !== requirement.version || manifest.license !== requirement.license) {
    throw new Error(
      `[node-web-environment] expected punycode@${requirement.version} (${requirement.license}); found ${manifest.name}@${manifest.version} (${manifest.license})`,
    );
  }
  return entry;
}

function packageProvenance(
  specifier: "ws" | "node-fetch",
  entryPath: string,
  bundle: Awaited<ReturnType<typeof bundleInstalledPackage>>,
): NodeWebEnvironmentModuleProvenance {
  const packageInfo = bundle.inputs.packages.find((item) => item.name === specifier);
  if (!packageInfo) throw new Error(`[node-web-environment] missing provenance for ${specifier}`);
  return Object.freeze({
    specifier,
    entryPath,
    packageVersion: packageInfo.version,
    license: packageInfo.license,
    packageClosure: bundle.inputs.packages,
    sourceFiles: bundle.inputs.sourceFiles,
    nativeImports: bundle.nativeImports,
    outputBytes: bundle.bytes,
    outputSha256: bundle.sha256,
    buildDefines:
      specifier === "ws"
        ? Object.freeze({
            "process.env.WS_NO_BUFFER_UTIL": true,
            "process.env.WS_NO_UTF_8_VALIDATE": true,
          })
        : Object.freeze({}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// @effect-diagnostics nodeBuiltinImport:off - prepares a synthetic release for a workerd proof.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

const ENTRY_NAME = "/$bunfs/root/cli";
const INTERNAL_CJS_NAME = "/$bunfs/root/lib/legacy.cjs";
const ADDON_SPECIFIER = "/$bunfs/root/node_modules/fixture-machine.node";
const ADDON_MEMBER = "performAction";
const REQUIRE_BOOTSTRAP =
  "globalThis[Symbol.for('signalbox.nodeBridge.v1')].require('node:module').createRequire('/signalbox/claude.js')";

interface RebundleArtifact {
  readonly manifest: {
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, { readonly path: string; readonly type: "js" }>>;
  };
}

export async function prepareNodeModuleProof(
  destination: string,
  rebundleModulePath: string,
): Promise<void> {
  const root = NodePath.resolve(destination);
  await NodeFSP.mkdir(root, { recursive: true });
  const extracted = await prepareExtraction(root);
  const layerModules = createNodeBridgeLayerModules(["fs", "module"]);
  const hookUrl = NodeURL.pathToFileURL(NodePath.resolve(rebundleModulePath)).href;
  const namespace: unknown = await import(hookUrl);
  if (!isRecord(namespace) || typeof namespace.rebundle !== "function") {
    throw new Error("NODE_MODULE_PROOF_REBUNDLE_HOOK_MISSING");
  }
  const artifactValue: unknown = await Reflect.apply(namespace.rebundle, namespace, [
    {
      extracted,
      output: NodePath.join(root, "release"),
      version: "fixture-node-module-v1",
      platform: "workerd-fixture",
      layerModules,
      requireBootstrap: REQUIRE_BOOTSTRAP,
    },
  ]);
  const artifact = readRebundleArtifact(artifactValue);

  await NodeFSP.writeFile(NodePath.join(root, "runtime.js"), await bundleRuntime());
  await NodeFSP.writeFile(NodePath.join(root, "yaml.js"), await bundleYamlCjs());
  await NodeFSP.writeFile(NodePath.join(root, "main.js"), createMainSource(artifact));

  const modulePaths = [
    "main.js",
    "runtime.js",
    "yaml.js",
    ...Object.values(artifact.manifest.modules).map((module) => `release/${module.path}`),
  ];
  if (!modulePaths.includes(`release/${artifact.manifest.mainModule}`)) {
    throw new Error("NODE_MODULE_PROOF_RELEASE_ENTRY_MISSING");
  }
  await NodeFSP.writeFile(
    NodePath.join(root, "manifest.json"),
    `${JSON.stringify(
      {
        id: "node-module-rebundle-proof-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeModuleFacet",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        modules: Object.fromEntries(modulePaths.map((path) => [path, { path, type: "js" }])),
        paths: ["/status", "/again"],
      },
      null,
      2,
    )}\n`,
  );
}

async function prepareExtraction(root: string): Promise<string> {
  const extracted = NodePath.join(root, "extracted");
  const modules = [
    {
      index: 0,
      name: ENTRY_NAME,
      loader: 1,
      encoding: 0,
      format: 1,
      artifactPath: "source/cli.js",
      source: createEntrySource(),
    },
    {
      index: 1,
      name: INTERNAL_CJS_NAME,
      loader: 1,
      encoding: 0,
      format: 2,
      artifactPath: "source/legacy.cjs",
      source:
        "(function(exports,require,module,__filename,__dirname){\n" +
        'module.exports = { kind: "literal-cjs", filename: __filename };\n' +
        "})",
    },
  ] as const;
  const manifestModules: Array<{
    index: number;
    name: string;
    key: string;
    loader: number;
    encoding: number;
    format: number;
    artifacts: { contents: { path: string; bytes: number; sha256: string } };
  }> = [];
  for (const module of modules) {
    const contents = new TextEncoder().encode(module.source);
    const path = NodePath.join(extracted, module.artifactPath);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents);
    manifestModules.push({
      index: module.index,
      name: module.name,
      key: module.name.replace(/^\/+/, ""),
      loader: module.loader,
      encoding: module.encoding,
      format: module.format,
      artifacts: {
        contents: {
          path: module.artifactPath,
          bytes: contents.byteLength,
          sha256: digest(contents),
        },
      },
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        binary: { bytes: 16, sha256: digest("synthetic-node-module-release") },
        graph: { entry: 0 },
        modules: manifestModules,
      },
      null,
      2,
    )}\n`,
  );
  return extracted;
}

function createEntrySource(): string {
  return `import fsDefault from "fs";
import nodeFsDefault from "node:fs";
import * as fsNamespace from "fs";
import * as nodeFsNamespace from "node:fs";
import moduleDefault from "node:module";

const literalCjs = import.meta.require(${JSON.stringify(INTERNAL_CJS_NAME)});

export function check(NodeModuleUnavailableError, NodeCapabilityNeedsMachineError) {
  const dynamicFs = import.meta.require(["f", "s"].join(""));
  const dynamicNodeFs = import.meta.require(["node:", "fs"].join(""));
  const dynamicModule = import.meta.require(["node:", "module"].join(""));
  const dynamicBareModule = import.meta.require(["mod", "ule"].join(""));
  const yamlSpecifier = ["ya", "ml"].join("");
  const yaml = import.meta.require(yamlSpecifier);
  const guestRequire = moduleDefault.createRequire("/guest/entry.js");
  const guestYaml = guestRequire(yamlSpecifier);
  const parsed = yaml.parse("answer: 42\\nitems:\\n  - name: fixture\\n");
  const roundTrip = yaml.parse(yaml.stringify(parsed));

  let missingError;
  try {
    import.meta.require(["./missing", "-prepared.cjs"].join(""));
  } catch (error) {
    missingError = error;
  }

  const addonSpecifier = ["/$bunfs/root/node_modules/", "fixture-machine.node"].join("");
  const addon = import.meta.require(addonSpecifier);
  const addonMember = Reflect.get(addon, ${JSON.stringify(ADDON_MEMBER)});
  let addonError;
  try {
    Reflect.apply(addonMember, addon, []);
  } catch (error) {
    addonError = error;
  }

  const checks = {
    fsImportAliasesShareFixture: fsDefault === nodeFsDefault &&
      fsNamespace.default === fsDefault && nodeFsNamespace.default === fsDefault,
    dynamicBuiltinAliasesShareFixture: dynamicFs === fsDefault && dynamicNodeFs === fsDefault,
    moduleFacadeAliasesShareIdentity: moduleDefault === dynamicModule &&
      moduleDefault === dynamicBareModule,
    literalInternalCjsWasBundled: literalCjs.kind === "literal-cjs" &&
      literalCjs.filename === ${JSON.stringify(INTERNAL_CJS_NAME)},
    yamlPackageParsesAndStringifies: yaml === guestYaml && parsed.answer === 42 &&
      roundTrip.answer === 42 && roundTrip.items[0].name === "fixture",
    missingPreparedModuleIsTyped: missingError instanceof NodeModuleUnavailableError &&
      missingError.code === "ERR_NODE_PREPARED_MODULE_UNAVAILABLE" &&
      missingError.operation === "require" &&
      missingError.specifier === "./missing-prepared.cjs",
    addonImportAndMemberReadAreSafe: Object.keys(addon).join(",") === ${JSON.stringify(ADDON_MEMBER)} &&
      typeof addonMember === "function",
    addonInvocationNeedsMachine: addonError instanceof NodeCapabilityNeedsMachineError &&
      addonError.code === "ERR_NODE_CAPABILITY_NEEDS_MACHINE" &&
      addonError.addon === ${JSON.stringify(ADDON_SPECIFIER)} &&
      addonError.member === ${JSON.stringify(ADDON_MEMBER)},
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
`;
}

async function bundleRuntime(): Promise<string> {
  const isolateDirectory = NodePath.dirname(
    NodeURL.fileURLToPath(new URL("../../src/isolate/NodeBootstrap.ts", import.meta.url)),
  );
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "node-module-runtime.ts",
      resolveDir: isolateDirectory,
      contents: [
        'export { bootNodeRelease } from "./NodeBootstrap.ts";',
        'export { createNodeModule, NodeModuleUnavailableError } from "./NodeModule.ts";',
        'export { createNodeEnvironmentResolver } from "./NodeEnvironment.ts";',
        'export { NodeCapabilityNeedsMachineError } from "./NodeNativeAddon.ts";',
      ].join("\n"),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  return outputText(result, "Node module runtime");
}

async function bundleYamlCjs(): Promise<string> {
  const cloudDirectory = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../..",
  );
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "yaml-cjs-package.js",
      resolveDir: cloudDirectory,
      contents: 'const yaml = require("yaml"); export default yaml;\n',
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    banner: {
      js: 'import {createRequire as nativeCreateRequire} from "node:module"; const require = nativeCreateRequire("/signalbox/environment.js");',
    },
    plugins: [
      {
        name: "yaml-process-esm-interop",
        setup(build) {
          build.onResolve({ filter: /^process$/ }, () => ({
            path: "process",
            namespace: "native-process",
          }));
          build.onLoad({ filter: /.*/, namespace: "native-process" }, () => ({
            contents: 'import process from "node:process"; module.exports = process;',
            loader: "js",
          }));
        },
      },
    ],
  });
  return outputText(result, "yaml CJS package");
}

function createMainSource(artifact: RebundleArtifact): string {
  return `import { DurableObject } from "cloudflare:workers";
import yaml from "./yaml.js";
import {
  bootNodeRelease,
  createNodeEnvironmentResolver,
  createNodeModule,
  NodeCapabilityNeedsMachineError,
  NodeModuleUnavailableError,
} from "./runtime.js";

const addonDeclaration = {
  specifier: ${JSON.stringify(ADDON_SPECIFIER)},
  members: [${JSON.stringify(ADDON_MEMBER)}],
};

async function bootRelease() {
  const fsFixture = Object.freeze({
    marker: "fixture-fs-object-not-real-node-fs",
    identify() { return "controlled-fs-fixture"; },
  });
  let installedBridge;
  const preparedCalls = [];
  const environment = createNodeEnvironmentResolver({
    packages: { yaml },
    addons: [addonDeclaration],
  });
  const module = createNodeModule({require(specifier) {
    if (!installedBridge) throw new Error("Node bridge is not installed");
    return installedBridge.require(specifier);
  }}, (specifier, referrer) => {
    preparedCalls.push({ specifier, referrer });
    return environment(specifier, referrer);
  });
  const loaded = await bootNodeRelease(
    { modules: { fs: fsFixture, module } },
    async (bridge) => {
      installedBridge = bridge;
      return import("./release/${artifactMainModule(artifact)}");
    },
  );
  return { release: loaded.release, preparedCalls, fsFixture };
}

export class NodeModuleFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS node_module_calls(n INTEGER)");
    this.ready = undefined;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/status" && path !== "/again") {
      return Response.json({ ok: false, checks: [{ name: "known proof path", ok: false }] }, { status: 404 });
    }
    this.ctx.storage.sql.exec("INSERT INTO node_module_calls VALUES (1)");
    const calls = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM node_module_calls").one().n;
    try {
      const loaded = await (this.ready ??= bootRelease());
      const result = loaded.release.check(NodeModuleUnavailableError, NodeCapabilityNeedsMachineError);
      const expectedCalls = path === "/status" ? 1 : 2;
      const preparedCalls = loaded.preparedCalls;
      const resolutionReferrersAreExact =
        preparedCalls.some(call => call.specifier === "yaml" && call.referrer === "/signalbox/claude.js") &&
        preparedCalls.some(call => call.specifier === "yaml" && call.referrer === "/guest/entry.js") &&
        preparedCalls.some(call => call.specifier === "./missing-prepared.cjs" && call.referrer === "/signalbox/claude.js") &&
        preparedCalls.some(call => call.specifier === ${JSON.stringify(ADDON_SPECIFIER)} && call.referrer === "/signalbox/claude.js");
      const internalCjsStayedBundled = result.checks.literalInternalCjsWasBundled &&
        !preparedCalls.some(call => call.specifier === ${JSON.stringify(INTERNAL_CJS_NAME)});
      const checks = [
        ...Object.entries(result.checks).map(([name, ok]) => ({ name, ok })),
        { name: "createRequire reached yaml and missing-module callbacks with exact referrers", ok: resolutionReferrersAreExact },
        { name: "literal CJS dependency stayed inside the rebundled graph", ok: internalCjsStayedBundled },
        { name: "host fs is the declared fixture object", ok: loaded.fsFixture.identify() === "controlled-fs-fixture" },
        { name: "two proof paths share SQL state in order", ok: calls === expectedCalls },
      ];
      const ok = result.ok && checks.every(check => check.ok);
      return Response.json({
        ok,
        result: { ok, checks },
        calls,
        preparedCalls,
        fixture: "fs is a deliberate fixture object, not real Node fs; the native addon is synthetic and has no machine implementation.",
      }, { status: ok ? 200 : 500 });
    } catch (error) {
      return Response.json({
        ok: false,
        result: { ok: false, checks: [{ name: "release boot and proof", ok: false, error: String(error) }] },
        calls,
      }, { status: 500 });
    }
  }
}
`;
}

function artifactMainModule(artifact: RebundleArtifact): string {
  return artifact.manifest.mainModule;
}

function readRebundleArtifact(value: unknown): RebundleArtifact {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    throw new Error("NODE_MODULE_PROOF_REBUNDLE_ARTIFACT_INVALID");
  }
  const mainModule = value.manifest.mainModule;
  const modulesValue = value.manifest.modules;
  if (typeof mainModule !== "string" || !isRecord(modulesValue)) {
    throw new Error("NODE_MODULE_PROOF_REBUNDLE_MANIFEST_INVALID");
  }
  const modules: Record<string, { path: string; type: "js" }> = {};
  for (const [name, candidate] of Object.entries(modulesValue)) {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || candidate.type !== "js") {
      throw new Error(`NODE_MODULE_PROOF_UNSUPPORTED_RELEASE_MODULE: ${name}`);
    }
    modules[name] = { path: candidate.path, type: "js" };
  }
  if (!Object.hasOwn(modules, mainModule)) {
    throw new Error("NODE_MODULE_PROOF_RELEASE_ENTRY_MISSING");
  }
  return { manifest: { mainModule, modules } };
}

function outputText(result: Esbuild.BuildResult, label: string): string {
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error(`${label} bundle was empty`);
  return source;
}

function digest(bytes: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [destination, rebundleModulePath] = process.argv.slice(2);
  if (!destination || !rebundleModulePath) {
    throw new Error("Usage: prepareModule.ts <fixture-output-directory> <rebundle-module-path>");
  }
  await prepareNodeModuleProof(NodePath.resolve(destination), NodePath.resolve(rebundleModulePath));
}

// @effect-diagnostics nodeBuiltinImport:off - prepares real package and Node builtin exports for workerd.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import {
  buildNodeEnvironment,
  type NodeEnvironmentBuild,
} from "../../src/isolate/NodeEnvironmentBuild.ts";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

const ENTRYPOINT = "NodeRuntimeClosureFacet";
const RELEASE_BUILTINS = [
  "constants",
  "fs",
  "fs/promises",
  "inspector",
  "module",
  "process",
  "querystring",
] as const;

export async function prepareNodeRuntimeClosureProof(destination: string): Promise<void> {
  const root = NodePath.resolve(destination);
  await NodeFSP.mkdir(root, { recursive: true });

  const environment = await buildNodeEnvironment();
  for (const module of environment.workerModules) {
    await writeModule(root, module.path, module.source);
  }
  for (const module of environment.startupWasm) {
    await writeBytes(root, module.path, module.bytes);
  }

  await NodeFSP.writeFile(NodePath.join(root, "runtime.js"), await bundleRuntime());
  await NodeFSP.writeFile(NodePath.join(root, "release.js"), await bundleRelease());
  await NodeFSP.writeFile(NodePath.join(root, "main.js"), createMainSource(environment));
  await NodeFSP.writeFile(
    NodePath.join(root, "manifest.json"),
    `${JSON.stringify(createManifest(environment), null, 2)}\n`,
  );
}

async function bundleRuntime(): Promise<string> {
  const root = NodePath.dirname(
    NodeURL.fileURLToPath(new URL("../../src/isolate/NodeBootstrap.ts", import.meta.url)),
  );
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "node-runtime-closure-runtime.ts",
      resolveDir: root,
      contents: [
        'export { createFacetSqliteStorage } from "../kernel/FacetSqliteStorage.ts";',
        'export { KernelFileSystem } from "../kernel/KernelFileSystem.ts";',
        'export * as BunJsc from "./NodeBunJsc.ts";',
        'export { bootNodeRelease } from "./NodeBootstrap.ts";',
        'export { createNodeConstants } from "./NodeConstants.ts";',
        'export { createNodeEnvironmentResolver } from "./NodeEnvironment.ts";',
        'export { createNodeFs } from "./NodeFs.ts";',
        'export { createNodeModule } from "./NodeModule.ts";',
        'export { createNodeProcess } from "./NodeProcess.ts";',
      ].join("\n"),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  return outputText(result, "Node runtime closure runtime");
}

async function bundleRelease(): Promise<string> {
  const layer = createNodeBridgeLayerModules(RELEASE_BUILTINS);
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "node-runtime-closure-release.js",
      contents: createReleaseSource(),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "node-runtime-closure-facades",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(layer, args.path)) return { path: args.path, namespace: "bridge" };
            throw new Error(`Unexpected runtime closure import: ${args.path}`);
          });
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => ({
            contents: layer[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  return outputText(result, "Node runtime closure release");
}

function createReleaseSource(): string {
  return `import constants from "node:constants";
import bareConstants from "constants";
import fs from "node:fs";
import inspector from "node:inspector";
import module from "node:module";
import process from "node:process";
import querystring from "node:querystring";
import bareQuerystring from "querystring";

export function check({ nodeFs, undici, yaml, BunJsc }) {
  const require = module.createRequire("/guest/release.js");
  const requiredJsc = require("bun:jsc");
  const jscErrors = ["edenGC", "heapStats"].map(member => {
    try { requiredJsc[member](); return false; }
    catch (error) {
      return error.code === "ERR_BUN_JSC_UNAVAILABLE" &&
        error.member === member && error.runtime === "v8";
    }
  });
  const requiredUndici = require("undici");
  const requiredYaml = require("yaml");
  const requiredConstants = require("node:constants");
  const requiredQuerystring = require("querystring");
  const requiredInspector = require("node:inspector");
  const encoded = querystring.stringify({ answer: "42", label: "workerd" });
  const parsed = querystring.parse(encoded);
  const checks = {
    constantsAliasesShareOneModule: constants === bareConstants &&
      constants === requiredConstants,
    filesystemFlagsMatchKernelAdapter: Object.entries(nodeFs.fs.constants).every(
      ([name, value]) => constants[name] === value,
    ),
    fsBuiltinSharesKernelModule: fs === nodeFs.fs,
    querystringAliasesUseNativeModule: querystring === bareQuerystring &&
      querystring === requiredQuerystring && parsed.answer === "42" && parsed.label === "workerd",
    inspectorUrlReportsNoActiveSession: inspector === requiredInspector &&
      typeof inspector.url === "function" && inspector.url() === undefined,
    guestExecArgvHasNoHostFlags: Array.isArray(process.execArgv) && process.execArgv.length === 0,
    jscImportSafeAndCallsExplicitlyUnsupported: requiredJsc === BunJsc && jscErrors.every(Boolean),
    preparedPackagesKeepRootIdentity: requiredUndici === undici && requiredYaml === yaml,
  };
  return { checks, inspectorExports: Object.keys(inspector).sort() };
}`;
}

function createMainSource(environment: NodeEnvironmentBuild): string {
  const yamlModulePath = JSON.stringify(`./${environment.packageEntrypoints.yaml}`);
  const undiciModulePath = JSON.stringify(`./${environment.packageEntrypoints.undici}`);
  return `import { DurableObject } from "cloudflare:workers";
import { PassThrough } from "node:stream";
import * as NativeConstants from "node:constants";
import * as NativeInspector from "node:inspector";
import * as NativeQuerystring from "node:querystring";
import {
  BunJsc,
  bootNodeRelease,
  createFacetSqliteStorage,
  createNodeConstants,
  createNodeEnvironmentResolver,
  createNodeFs,
  createNodeModule,
  createNodeProcess,
  KernelFileSystem,
} from "./runtime.js";

const packageEntrypoints = ${JSON.stringify(environment.packageEntrypoints)};

async function loadProof(nodeFs, nodeProcess) {
  const [yamlNamespace, undiciNamespace] = await Promise.all([
    import(${yamlModulePath}),
    import(${undiciModulePath}),
  ]);
  const yaml = yamlNamespace.default;
  const undici = undiciNamespace.default;
  if (!yaml || !undici) throw new TypeError("Prepared package module omitted its actual root export");

  const constants = createNodeConstants(NativeConstants, nodeFs.fs);
  const resolver = createNodeEnvironmentResolver({ packages: { yaml, undici, "bun:jsc": BunJsc }, addons: [] });
  let installedBridge;
  const nodeModule = createNodeModule({
    require(specifier) {
      if (!installedBridge) throw new Error("Node bridge is not installed");
      return installedBridge.require(specifier);
    },
  }, resolver);
  const loaded = await bootNodeRelease({
    modules: {
      ...nodeFs,
      constants,
      inspector: NativeInspector,
      module: nodeModule,
      process: nodeProcess,
      querystring: NativeQuerystring,
    },
    globals: { process: nodeProcess },
  }, async bridge => {
    installedBridge = bridge;
    return import("./release.js");
  });
  return { ...loaded, nodeFs, undici, yaml, BunJsc };
}

export class ${ENTRYPOINT} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = createFacetSqliteStorage(ctx.storage, () => 1800000000000000000n);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }], cwd: "/" });
    const streams = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    };
    const envVars = { HOME: "/work/home", TMPDIR: "/work/tmp" };
    const identity = {
      version: "v24.21.0",
      versions: { node: "24.21.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/work/home",
      tmpdir: "/work/tmp",
      pid: 1,
      ppid: 0,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node", "/guest/release.js"],
      execArgv: [],
    };
    const nodeFs = createNodeFs(filesystem);
    const nodeProcess = createNodeProcess({ filesystem, env: envVars, identity, streams });
    this.ready = loadProof(nodeFs, nodeProcess);
  }

  async fetch() {
    try {
      const loaded = await this.ready;
      const result = loaded.release.check({
        BunJsc: loaded.BunJsc,
        nodeFs: loaded.nodeFs,
        undici: loaded.undici,
        yaml: loaded.yaml,
      });
      const checks = result.checks;
      const ok = Object.values(checks).every(value => value === true);
      return Response.json({
        ok,
        checks,
        inspectorExports: result.inspectorExports,
        note: "This proves prepared undici and yaml identity, kernel filesystem flag compatibility, native querystring, and inspector.url() when no inspector session is active. Other inspector methods and agent turns are not covered.",
      }, { status: ok ? 200 : 500 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: { name: error?.name, message: error?.message, stack: error?.stack },
        packageEntrypoints,
        note: "The package or builtin closure failed during module load or request.",
      }, { status: 500 });
    }
  }
}`;
}

function createManifest(environment: NodeEnvironmentBuild) {
  const modules: Record<string, { path: string; type: "js" | "wasm" }> = {
    "main.js": { path: "main.js", type: "js" },
    "runtime.js": { path: "runtime.js", type: "js" },
    "release.js": { path: "release.js", type: "js" },
  };
  for (const module of environment.workerModules) {
    modules[module.path] = { path: module.path, type: "js" };
  }
  for (const module of environment.startupWasm) {
    modules[module.path] = { path: module.path, type: "wasm" };
  }
  return {
    id: "node-runtime-closure-v1",
    mode: "facet",
    mainModule: "main.js",
    entrypoint: ENTRYPOINT,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    modules,
    paths: ["/status", "/again"],
  };
}

async function writeModule(root: string, path: string, source: string): Promise<void> {
  const destination = NodePath.join(root, path);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, source);
}

async function writeBytes(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = NodePath.join(root, path);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, bytes);
}

function outputText(result: Esbuild.BuildResult, label: string): string {
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error(`${label} bundle was empty`);
  return source;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a prepared module output directory");
  await prepareNodeRuntimeClosureProof(NodePath.resolve(destination));
}

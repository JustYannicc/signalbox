// @effect-diagnostics nodeBuiltinImport:off - prepares real package modules for the workerd proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import {
  buildNodeEnvironment,
  type NodeEnvironmentBuild,
} from "../../src/isolate/NodeEnvironmentBuild.ts";

const ENTRYPOINT = "NodeEnvironmentFacet";

/** Prepare the pinned yaml and undici roots as separate WorkerLoader modules. */
export async function prepareNodeEnvironmentProof(destination: string): Promise<void> {
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
  await NodeFSP.writeFile(
    NodePath.join(root, "release.js"),
    createReleaseSource(installedUndiciRootExports()),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "main.js"),
    createMainSource(environment, packageNativeImports(environment)),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "manifest.json"),
    `${JSON.stringify(createManifest(environment), null, 2)}\n`,
  );
}

async function bundleRuntime(): Promise<string> {
  const isolateDirectory = NodePath.dirname(
    NodeURL.fileURLToPath(new URL("../../src/isolate/NodeBootstrap.ts", import.meta.url)),
  );
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "node-environment-runtime.ts",
      resolveDir: isolateDirectory,
      contents: [
        'export { bootNodeRelease } from "./NodeBootstrap.ts";',
        'export { createNodeModule } from "./NodeModule.ts";',
        'export { createNodeEnvironmentResolver } from "./NodeEnvironment.ts";',
      ].join("\n"),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  return outputText(result, "Node environment runtime");
}

function createReleaseSource(expectedExports: readonly string[]): string {
  return `export async function check({ yaml, undici, nodeModule }) {
  const require = nodeModule.createRequire('/signalbox/release.js');
  const dynamicUndici = require('undici');
  const parsed = yaml.parse('answer: 42\\nitems:\\n  - name: fixture\\n');
  const roundTrip = yaml.parse(yaml.stringify(parsed));
  const expectedExports = ${JSON.stringify(expectedExports)};
  const requiredFunctionExports = [
    'Agent', 'Dispatcher', 'Client', 'Pool', 'BalancedPool', 'ProxyAgent',
    'request', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'WebSocket',
  ];
  const actualExports = Object.keys(undici).sort();
  const rootExportsPresent = expectedExports.every(name => Object.hasOwn(undici, name)) &&
    requiredFunctionExports.every(name =>
    Object.hasOwn(undici, name) && typeof undici[name] === 'function');
  const rootExportsMatchInstalledPackage = actualExports.length === expectedExports.length &&
    actualExports.every((name, index) => name === expectedExports[index]);
  const agent = new undici.Agent({ connections: 1 });
  const realAgentShape = agent instanceof undici.Agent &&
    agent.constructor === undici.Agent && typeof agent.dispatch === 'function';
  await agent.close();
  const checks = {
    yamlParseAndStringify: parsed.answer === 42 && parsed.items[0].name === 'fixture' &&
      roundTrip.answer === 42 && roundTrip.items[0].name === 'fixture',
    undiciRootExportsPresent: rootExportsPresent && rootExportsMatchInstalledPackage,
    dynamicRequireSharesImportedRoot: dynamicUndici === undici,
    noFakeAgentExport: !Object.hasOwn(undici, 'fakeAgent') &&
      realAgentShape,
    noGlobalFetchSubstitution: undici.fetch !== globalThis.fetch,
    agentClosed: true,
  };
  return { checks, rootExports: Object.keys(undici).sort() };
}`;
}

function createMainSource(
  environment: NodeEnvironmentBuild,
  nativeImports: readonly string[],
): string {
  return `import { DurableObject } from 'cloudflare:workers';
import {
  bootNodeRelease,
  createNodeEnvironmentResolver,
  createNodeModule,
} from './runtime.js';

const packageEntrypoints = ${JSON.stringify(environment.packageEntrypoints)};
const nativePackageImports = ${JSON.stringify(nativeImports)};

async function loadProof() {
  const [yamlNamespace, undiciNamespace] = await Promise.all([
    import(${JSON.stringify(`./${environment.packageEntrypoints.yaml}`)}),
    import(${JSON.stringify(`./${environment.packageEntrypoints.undici}`)}),
  ]);
  const yaml = yamlNamespace.default;
  const undici = undiciNamespace.default;
  if (!yaml || !undici) throw new TypeError('Prepared package module omitted its default root export');

  const resolver = createNodeEnvironmentResolver({ packages: { yaml, undici }, addons: [] });
  let installedBridge;
  const nodeModule = createNodeModule({ require(specifier) {
    if (!installedBridge) throw new Error('Node bridge is not installed');
    return installedBridge.require(specifier);
  } }, resolver);
  const loaded = await bootNodeRelease({ modules: { module: nodeModule } }, async bridge => {
    installedBridge = bridge;
    return import('./release.js');
  });
  return { yaml, undici, ...loaded };
}

function describeError(error) {
  if (error && typeof error === 'object') {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
    };
  }
  return { message: String(error), stack: undefined };
}

export class ${ENTRYPOINT} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_environment_calls(n INTEGER)');
    this.ready = undefined;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/status' && path !== '/again') {
      return Response.json({ ok: false, error: 'unknown proof path' }, { status: 404 });
    }

    this.ctx.storage.sql.exec('INSERT INTO node_environment_calls VALUES (1)');
    const calls = this.ctx.storage.sql.exec(
      'SELECT count(*) AS n FROM node_environment_calls',
    ).one().n;
    try {
      const loaded = await (this.ready ??= loadProof());
      const result = await loaded.release.check({
        yaml: loaded.yaml,
        undici: loaded.undici,
        nodeModule: loaded.personality.bridge.require('node:module'),
      });
      const expectedCalls = path === '/status' ? 1 : 2;
      const checks = { ...result.checks, sqlCallsInOrder: calls === expectedCalls };
      const ok = Object.values(checks).every(value => value === true);
      return Response.json({
        ok,
        calls,
        checks,
        rootExports: result.rootExports,
        nativePackageImports,
        note: 'Prepared yaml and undici root exports plus Agent construction and close only. No network request or transport behavior is claimed.',
      }, { status: ok ? 200 : 500 });
    } catch (error) {
      return Response.json({
        ok: false,
        calls,
        error: describeError(error),
        nativePackageImports,
        packageEntrypoints,
        note: 'Package load or request-time require failed. The stack and native import list are included; no network request was made.',
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
    id: "node-real-packages-v1",
    mode: "facet",
    mainModule: "main.js",
    entrypoint: ENTRYPOINT,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    modules,
    paths: ["/status", "/again"],
  };
}

function packageNativeImports(environment: NodeEnvironmentBuild): string[] {
  const imports = new Set<string>();
  for (const module of environment.workerModules) {
    for (const match of module.source.matchAll(
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier && NodeModule.isBuiltin(specifier)) imports.add(specifier);
    }
  }
  return [...imports].sort();
}

function installedUndiciRootExports(): string[] {
  const cloudRequire = NodeModule.createRequire(new URL("../../package.json", import.meta.url));
  const exports: unknown = cloudRequire("undici");
  if ((typeof exports !== "object" && typeof exports !== "function") || exports === null) {
    throw new Error("[node-environment] installed undici root did not return an export object");
  }
  return Object.keys(exports).sort();
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
  await prepareNodeEnvironmentProof(NodePath.resolve(destination));
}

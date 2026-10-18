// @effect-diagnostics nodeBuiltinImport:off - prepares real package modules for the workerd proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";
import {
  buildNodeWebEnvironment,
  type NodeWebEnvironmentBuild,
  type NodeWebEnvironmentPackageName,
} from "../../src/isolate/NodeWebEnvironmentBuild.ts";

const ENTRYPOINT = "NodeWebEnvironmentFacet";
const MODULE_PATHS = Object.freeze({
  ws: "node/environment/ws.js",
  "node-fetch": "node/environment/node-fetch.js",
  "bun:jsc": "node/environment/bun-jsc.js",
} satisfies Record<NodeWebEnvironmentPackageName, string>);

const PROOF_LIMITS = Object.freeze([
  "This loads the pinned ws and node-fetch package sources and checks their export identities.",
  "The fixture imports package modules before NodeBridge installation, so their node:* imports resolve natively at load time; this does not prove bridge-owned filesystem or process I/O.",
  "The package map adds no native createRequire banner. Release integration must route its node:* imports through bridge facades before package evaluation and rebind any native createRequire banner to the bridged node:module and process facades.",
  "The ws check exercises its real Sender and Receiver without opening a socket or making a network request.",
  "The node-fetch check uses an in-memory Response; it does not exercise HTTP transport.",
  "This does not prove a Claude turn or the Node http, https, net, or tls adapters.",
]);

/** Prepare real package roots and their pre-release NodeModule resolver for a workerd fixture. */
export async function prepareNodeWebEnvironmentProof(destination: string): Promise<void> {
  const root = NodePath.resolve(destination);
  await NodeFSP.mkdir(root, { recursive: true });

  const cloudRequire = NodeModule.createRequire(new URL("../../package.json", import.meta.url));
  const environment = await buildNodeWebEnvironment({
    ws: cloudRequire.resolve("ws"),
    "node-fetch": cloudRequire.resolve("node-fetch"),
  });
  for (const [specifier, source] of Object.entries(environment.environmentPackageModules)) {
    await writeModule(root, MODULE_PATHS[specifier as NodeWebEnvironmentPackageName], source);
  }
  await NodeFSP.writeFile(
    NodePath.join(root, "provenance.json"),
    `${JSON.stringify(environment.provenance, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(root, "runtime.js"), await bundleRuntime());
  await NodeFSP.writeFile(NodePath.join(root, "release.js"), await bundleRelease(root));
  await NodeFSP.writeFile(NodePath.join(root, "main.js"), createMainSource(environment));
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
      sourcefile: "node-web-environment-runtime.ts",
      resolveDir: isolateDirectory,
      contents: [
        'export { bootNodeRelease } from "./NodeBootstrap.ts";',
        'export { createNodeEnvironmentResolver } from "./NodeEnvironment.ts";',
        'export { createNodeModule } from "./NodeModule.ts";',
      ].join("\n"),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  return outputText(result, "Node web environment runtime");
}

async function bundleRelease(root: string): Promise<string> {
  const bridgeModules = createNodeBridgeLayerModules(["buffer", "module"]);
  const result = await Esbuild.build({
    stdin: {
      sourcefile: "release.js",
      resolveDir: root,
      contents: createReleaseSource(),
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    metafile: true,
    plugins: [
      {
        name: "node-web-environment-facades",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(bridgeModules, args.path)) {
              return { path: args.path, namespace: "node-web-environment-bridge" };
            }
            if (args.path === "ws" || args.path === "node-fetch" || args.path === "bun:jsc") {
              const path = MODULE_PATHS[args.path as NodeWebEnvironmentPackageName];
              return { path: `./${path}`, external: true };
            }
            throw new Error(`[node-web-environment] unexpected release import: ${args.path}`);
          });
          build.onLoad({ filter: /.*/, namespace: "node-web-environment-bridge" }, (args) => ({
            contents: bridgeModules[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const source = outputText(result, "Node web environment release");
  const remaining = [
    ...new Set(
      Object.values(result.metafile?.outputs ?? {}).flatMap((output) =>
        output.imports.filter((item) => item.external).map((item) => item.path),
      ),
    ),
  ];
  const expected = Object.values(MODULE_PATHS)
    .map((path) => `./${path}`)
    .sort();
  if (
    remaining.length !== expected.length ||
    remaining.toSorted().some((path, index) => path !== expected[index])
  ) {
    throw new Error(
      `[node-web-environment] unexpected release externals: ${remaining.toSorted().join(", ")}`,
    );
  }
  return source;
}

function createReleaseSource(): string {
  return `import WebSocket, {
  WebSocket as NamedWebSocket,
  WebSocketServer,
  createWebSocketStream,
  extension,
  PerMessageDeflate,
  Receiver,
  Sender,
  subprotocol,
} from "ws";
import fetch, {
  AbortError,
  FetchError,
  Headers,
  Request,
  Response,
} from "node-fetch";
import * as bunJsc from "bun:jsc";
import Buffer from "node:buffer";
import nodeModule from "node:module";

export async function check() {
  const require = nodeModule.createRequire("/signalbox/release.js");
  const cjsWebSocket = require("ws");
  const cjsFetch = require("node-fetch");
  const cjsBunJsc = require("bun:jsc");
  const dynamicFetch = await import("node-fetch");
  const response = new Response(Buffer.from([0, 255, 1, 2]), {
    status: 206,
    headers: { "content-type": "application/octet-stream" },
  });
  const responseBytes = Array.from(new Uint8Array(await response.arrayBuffer()));
  const idnRequest = new Request("https://münich.example/");
  const surrogatePairRequest = new Request("https://𝒜.example/");

  const payload = Buffer.from([0, 255, 3, 128, 42]);
  const maskBuffer = Buffer.alloc(4);
  const frame = Buffer.concat(Sender.frame(payload, {
    fin: true,
    mask: true,
    generateMask: mask => mask.set([17, 34, 51, 68]),
    maskBuffer,
    opcode: 2,
    readOnly: true,
    rsv1: false,
  }));
  const receiver = new Receiver({ isServer: true });
  const received = new Promise((resolve, reject) => {
    receiver.on("message", (data, isBinary) => resolve({ data, isBinary }));
    receiver.once("error", reject);
  });
  receiver.end(frame);
  const message = await received;

  let edenGCError;
  let heapStatsError;
  try {
    bunJsc.edenGC();
  } catch (error) {
    edenGCError = error;
  }
  try {
    bunJsc.heapStats();
  } catch (error) {
    heapStatsError = error;
  }

  const checks = {
    wsDefaultIdentity: WebSocket === NamedWebSocket && WebSocket === cjsWebSocket,
    wsNamedExports: [
      WebSocketServer, createWebSocketStream, PerMessageDeflate, Receiver, Sender,
    ].every(value => typeof value === "function") &&
      typeof extension.format === "function" && typeof extension.parse === "function" &&
      typeof subprotocol.parse === "function" &&
      cjsWebSocket.extension === extension && cjsWebSocket.subprotocol === subprotocol,
    wsCommonJsNamedIdentity: cjsWebSocket.Receiver === Receiver && cjsWebSocket.Sender === Sender &&
      cjsWebSocket.WebSocket === WebSocket,
    wsBinaryFrameRoundTrip: message.isBinary === true &&
      Array.from(message.data).join(",") === Array.from(payload).join(","),
    fetchDefaultIdentity: fetch === cjsFetch && dynamicFetch.default === fetch,
    fetchCommonJsNamedIdentity: cjsFetch.Headers === Headers && cjsFetch.Request === Request &&
      cjsFetch.Response === Response && cjsFetch.FetchError === FetchError &&
      cjsFetch.AbortError === AbortError,
    fetchDynamicImportIdentity: dynamicFetch.Headers === Headers && dynamicFetch.Response === Response,
    fetchResponseBytes: response.status === 206 &&
      response.headers.get("content-type") === "application/octet-stream" &&
      responseBytes.join(",") === "0,255,1,2",
    fetchPunycodeUsesPinnedUserland: idnRequest.url === "https://xn--mnich-kva.example/" &&
      surrogatePairRequest.url === "https://a.example/",
    jscCommonJsIdentity: cjsBunJsc === bunJsc,
    jscUnsupportedCallsAreTyped: edenGCError?.code === "ERR_BUN_JSC_UNAVAILABLE" &&
      edenGCError?.runtime === "v8" && edenGCError?.member === "edenGC" &&
      heapStatsError?.code === "ERR_BUN_JSC_UNAVAILABLE" &&
      heapStatsError?.runtime === "v8" && heapStatsError?.member === "heapStats",
  };
  return {
    checks,
    wsExports: [
      "default", "WebSocket", "WebSocketServer", "createWebSocketStream", "extension",
      "PerMessageDeflate", "Receiver", "Sender", "subprotocol",
    ],
    nodeFetchExports: ["default", "AbortError", "FetchError", "Headers", "Request", "Response"],
  };
}`;
}

function createMainSource(environment: NodeWebEnvironmentBuild): string {
  const nativeSpecifiers = [...new Set([...environment.nativeImports, "node:buffer"])].sort();
  const imports = nativeSpecifiers
    .map((specifier, index) => `import * as native${index} from ${JSON.stringify(specifier)};`)
    .join("\n");
  const moduleMap = nativeSpecifiers
    .map((specifier, index) => `  ${JSON.stringify(specifier.slice(5))}: native${index},`)
    .join("\n");
  const modulePaths = JSON.stringify(MODULE_PATHS);
  const nativeImports = JSON.stringify(environment.nativeImports);
  return `import { DurableObject } from "cloudflare:workers";
import { bootNodeRelease, createNodeEnvironmentResolver, createNodeModule } from "./runtime.js";
${imports}

const packageModulePaths = ${modulePaths};
const nativePackageImports = ${nativeImports};
const hostModules = {
${moduleMap}
};

async function loadProof() {
  const [wsNamespace, fetchNamespace, jscNamespace] = await Promise.all([
    import("./" + packageModulePaths.ws),
    import("./" + packageModulePaths["node-fetch"]),
    import("./" + packageModulePaths["bun:jsc"]),
  ]);
  const packages = {
    ws: wsNamespace.default,
    "node-fetch": fetchNamespace.default,
    "bun:jsc": jscNamespace,
  };
  const resolver = createNodeEnvironmentResolver({ packages, addons: [] });
  let installedBridge;
  const nodeModule = createNodeModule({
    require(specifier) {
      if (!installedBridge) throw new Error("Node bridge is not installed");
      return installedBridge.require(specifier);
    },
  }, resolver);
  const loaded = await bootNodeRelease({ modules: { ...hostModules, module: nodeModule } }, async bridge => {
    installedBridge = bridge;
    return import("./release.js");
  });
  return { ...loaded, packages };
}

function describeError(error) {
  return error && typeof error === "object"
    ? { name: error.name, message: error.message, code: error.code, stack: error.stack }
    : { message: String(error) };
}

export class ${ENTRYPOINT} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS node_web_environment_calls(n INTEGER)");
    this.ready = undefined;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/status" && path !== "/again") {
      return Response.json({ ok: false, error: "unknown proof path" }, { status: 404 });
    }
    this.ctx.storage.sql.exec("INSERT INTO node_web_environment_calls VALUES (1)");
    const calls = this.ctx.storage.sql.exec(
      "SELECT count(*) AS n FROM node_web_environment_calls",
    ).one().n;
    try {
      const loaded = await (this.ready ??= loadProof());
      const result = await loaded.release.check();
      const expectedCalls = path === "/status" ? 1 : 2;
      const checks = { ...result.checks, sqlCallsInOrder: calls === expectedCalls };
      const ok = Object.values(checks).every(value => value === true);
      return Response.json({
        ok,
        calls,
        checks,
        wsExports: result.wsExports,
        nodeFetchExports: result.nodeFetchExports,
        nativePackageImports,
        packageModulePaths,
        proofLimits: ${JSON.stringify(PROOF_LIMITS)},
      }, { status: ok ? 200 : 500 });
    } catch (error) {
      return Response.json({
        ok: false,
        calls,
        error: describeError(error),
        nativePackageImports,
        packageModulePaths,
        proofLimits: ${JSON.stringify(PROOF_LIMITS)},
      }, { status: 500 });
    }
  }
}`;
}

function createManifest(environment: NodeWebEnvironmentBuild) {
  const modules: Record<string, { path: string; type: "js" }> = {
    "main.js": { path: "main.js", type: "js" },
    "runtime.js": { path: "runtime.js", type: "js" },
    "release.js": { path: "release.js", type: "js" },
  };
  for (const path of Object.values(MODULE_PATHS)) modules[path] = { path, type: "js" };
  return {
    id: "node-web-environment-v1",
    mode: "facet",
    mainModule: "main.js",
    entrypoint: ENTRYPOINT,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    modules,
    paths: ["/status", "/again"],
    nativePackageImports: environment.nativeImports,
    moduleMapSha256: environment.provenance.moduleMapSha256,
    packageModulesImportedBeforeBridge: true,
    nativeCreateRequireBanner: false,
    releaseIntegrationRequirements: {
      routeNativeImportsThroughBridgeBeforePackageEvaluation: true,
      rebindNativeCreateRequireBannerToNodeModuleAndProcessFacades: true,
    },
  };
}

async function writeModule(root: string, path: string, source: string): Promise<void> {
  const destination = NodePath.join(root, path);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, source);
}

function outputText(result: Esbuild.BuildResult, label: string): string {
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error(`${label} bundle was empty`);
  return source;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a prepared module output directory");
  await prepareNodeWebEnvironmentProof(NodePath.resolve(destination));
}

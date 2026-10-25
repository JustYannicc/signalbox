// @effect-diagnostics nodeBuiltinImport:off - packages are prepared in Node before WorkerLoader startup.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Esbuild from "esbuild";
import { buildNodeEnvironment } from "../../src/isolate/NodeEnvironmentBuild.ts";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";
import { NODE_BUILTIN_ROUTES, type NodeBuiltinName } from "../../src/isolate/NodeBuiltinMap.ts";

/** Keep the accepted package/WASM build, but bind every native entry import to the guest bridge. */
export async function prepareProofEnvironment() {
  const environment = await buildNodeEnvironment();
  const facades = createNodeBridgeLayerModules(
    Object.keys(NODE_BUILTIN_ROUTES) as NodeBuiltinName[],
  );
  const workerModules = [];
  for (const module of environment.workerModules) {
    const result = await Esbuild.build({
      stdin: { contents: module.source, sourcefile: module.path, loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minifyWhitespace: true,
      legalComments: "eof",
      plugins: [
        {
          name: "proof-package-bridge",
          setup(build) {
            build.onResolve({ filter: /.*/ }, ({ path }) => {
              if (Object.hasOwn(facades, path)) return { path, namespace: "proof-bridge" };
              if (path === "./llhttp-simd.wasm" || path === "./llhttp.wasm")
                return { path, external: true };
              throw new Error(`Prepared package ${module.path} has an unowned import: ${path}`);
            });
            build.onLoad({ filter: /.*/, namespace: "proof-bridge" }, ({ path }) => ({
              contents: facades[path]!,
              loader: "js",
            }));
          },
        },
      ],
    });
    const output = result.outputFiles[0];
    if (!output || result.outputFiles.length !== 1)
      throw new Error(`Package must emit one module: ${module.path}`);
    workerModules.push({ path: module.path, type: "js" as const, source: output.text });
  }
  const hash = (source: string | Uint8Array) =>
    NodeCrypto.createHash("sha256").update(source).digest("hex");
  const routeSource = JSON.stringify(NODE_BUILTIN_ROUTES);
  const inputs: Record<string, string> = {};
  for (const path of [
    "NodeBridge.ts",
    "NodeBuiltinMap.ts",
    "NodeEnvironmentBuild.ts",
    "NodeEnvironment.ts",
    "NodeModule.ts",
    "NodeBunJsc.ts",
  ]) {
    inputs[path] = hash(
      await NodeFSP.readFile(new URL(`../../src/isolate/${path}`, import.meta.url)),
    );
  }
  const provenance = {
    esbuildVersion: Esbuild.version,
    inputs,
    routes: NODE_BUILTIN_ROUTES,
    routesSha256: hash(routeSource),
    facadeSources: Object.fromEntries(
      Object.entries(facades).map(([name, source]) => [
        name,
        { bytes: new TextEncoder().encode(source).byteLength, sha256: hash(source) },
      ]),
    ),
    raw: environment.workerModules.map((module) => ({
      path: module.path,
      bytes: new TextEncoder().encode(module.source).byteLength,
      sha256: hash(module.source),
    })),
    rebound: workerModules.map((module) => ({
      path: module.path,
      bytes: new TextEncoder().encode(module.source).byteLength,
      sha256: hash(module.source),
    })),
    startupWasm: environment.startupWasm.map((module) => ({
      path: module.path,
      bytes: module.bytes.byteLength,
      sha256: hash(module.bytes),
    })),
  };
  return { ...environment, workerModules, raw: environment, provenance };
}

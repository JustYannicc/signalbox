// @effect-diagnostics nodeBuiltinImport:off - prepares real Node package exports for WorkerLoader.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { version as acornVersion } from "acorn";
import * as Esbuild from "esbuild";
import {
  transformUndiciClientH1Source,
  UNDICI_WASM_IMPORTS,
} from "./node/environment-build/UndiciWasmTransform.ts";
import {
  assertBundledEntry,
  assertOnlyNativeAndWasmImports,
  assertWasmSourcesNotBundled,
  verifyPackage,
} from "./node/environment-build/PackageValidation.ts";

export { transformUndiciClientH1Source, UNDICI_WASM_IMPORTS };

export type NodeEnvironmentPackageName = "undici" | "yaml";

export interface NodeEnvironmentWorkerModule {
  readonly path: string;
  readonly type: "js";
  readonly source: string;
}

export interface NodeEnvironmentStartupWasm {
  readonly path: string;
  readonly type: "wasm";
  readonly bytes: Uint8Array;
}

export interface NodeEnvironmentBuild {
  /** Entrypoints export each package's actual root require() value as the default export. */
  readonly packageEntrypoints: Readonly<Record<NodeEnvironmentPackageName, string>>;
  readonly workerModules: readonly NodeEnvironmentWorkerModule[];
  /** These bytes are separate WorkerLoader modules so workerd compiles them at startup. */
  readonly startupWasm: readonly NodeEnvironmentStartupWasm[];
}

const PACKAGE_REQUIREMENTS = Object.freeze({
  acorn: { version: "8.16.0", license: "MIT" },
  esbuild: { version: "0.28.2", license: "MIT" },
  undici: { version: "8.11.2", license: "MIT" },
  yaml: { version: "2.9.0", license: "ISC" },
} as const);

const OUTPUT_PATHS = Object.freeze({
  packages: Object.freeze({
    yaml: "node/environment/yaml.js",
    undici: "node/environment/undici.js",
  }),
  wasm: Object.freeze({
    simd: "node/environment/llhttp-simd.wasm",
    fallback: "node/environment/llhttp.wasm",
  }),
});

const WASM_RESOLUTIONS = Object.freeze({
  [UNDICI_WASM_IMPORTS.simd]: {
    importPath: "./llhttp-simd.wasm",
  },
  [UNDICI_WASM_IMPORTS.fallback]: {
    importPath: "./llhttp.wasm",
  },
});

const NATIVE_REQUIRE_BANNER =
  'import { createRequire as nativeCreateRequire } from "node:module"; const require = nativeCreateRequire("/signalbox/environment.js");';

/** Bundle pinned package roots without writing files or replacing their behavior. */
export async function buildNodeEnvironment(): Promise<NodeEnvironmentBuild> {
  const cloudRequire = NodeModule.createRequire(import.meta.url);
  const packageEntries = {
    yaml: cloudRequire.resolve("yaml"),
    undici: cloudRequire.resolve("undici"),
  } satisfies Record<NodeEnvironmentPackageName, string>;

  for (const [name, expected] of Object.entries(PACKAGE_REQUIREMENTS)) {
    const entry =
      name === "acorn"
        ? cloudRequire.resolve("acorn")
        : name === "esbuild"
          ? cloudRequire.resolve("esbuild")
          : packageEntries[name as NodeEnvironmentPackageName];
    verifyPackage(name, entry, expected.version, expected.license);
  }
  if (acornVersion !== PACKAGE_REQUIREMENTS.acorn.version) {
    throw new Error(
      `[node-environment] expected acorn ${PACKAGE_REQUIREMENTS.acorn.version}; found ${acornVersion}`,
    );
  }
  if (Esbuild.version !== PACKAGE_REQUIREMENTS.esbuild.version) {
    throw new Error(
      `[node-environment] expected esbuild ${PACKAGE_REQUIREMENTS.esbuild.version}; found ${Esbuild.version}`,
    );
  }

  const undiciRequire = NodeModule.createRequire(packageEntries.undici);
  const wasm = [
    readWasm(undiciRequire, "./lib/llhttp/llhttp_simd-wasm.js", OUTPUT_PATHS.wasm.simd),
    readWasm(undiciRequire, "./lib/llhttp/llhttp-wasm.js", OUTPUT_PATHS.wasm.fallback),
  ] as const;
  const yamlModule = await bundlePackage("yaml", packageEntries.yaml);
  const undiciModule = await bundlePackage("undici", packageEntries.undici, {
    packageEntry: packageEntries.undici,
    wasmPaths: wasm.map(({ sourcePath }) => sourcePath),
  });

  return Object.freeze({
    packageEntrypoints: OUTPUT_PATHS.packages,
    workerModules: Object.freeze([
      Object.freeze({ path: OUTPUT_PATHS.packages.yaml, type: "js" as const, source: yamlModule }),
      Object.freeze({
        path: OUTPUT_PATHS.packages.undici,
        type: "js" as const,
        source: undiciModule,
      }),
    ]),
    startupWasm: Object.freeze(
      wasm.map(({ path, bytes }) =>
        Object.freeze({ path, type: "wasm" as const, bytes: Uint8Array.from(bytes) }),
      ),
    ),
  });
}

interface ReadWasm {
  readonly path: string;
  readonly sourcePath: string;
  readonly bytes: Uint8Array;
}

interface UndiciBundleOptions {
  readonly packageEntry: string;
  readonly wasmPaths: readonly string[];
}

function readWasm(
  packageRequire: ReturnType<typeof NodeModule.createRequire>,
  specifier: string,
  outputPath: string,
): ReadWasm {
  const sourcePath = packageRequire.resolve(specifier);
  const value: unknown = packageRequire(specifier);
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`[node-environment] ${specifier} did not export WebAssembly bytes`);
  }
  const bytes = Uint8Array.from(value);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`[node-environment] ${specifier} is not a WebAssembly binary`);
  }
  return { path: outputPath, sourcePath: NodeFS.realpathSync(sourcePath), bytes };
}

async function bundlePackage(
  packageName: NodeEnvironmentPackageName,
  entry: string,
  undici?: UndiciBundleOptions,
): Promise<string> {
  let transformedClientH1 = 0;
  const plugins: Esbuild.Plugin[] = [processInteropPlugin()];
  if (undici) plugins.push(undiciWasmPlugin(undici, () => transformedClientH1++));

  const workingDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const build = await Esbuild.build({
    absWorkingDir: workingDirectory,
    stdin: {
      contents: `const packageExports = require(${JSON.stringify(packageName)}); export default packageExports;`,
      resolveDir: NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      sourcefile: `node-environment-${packageName}.js`,
      loader: "js",
    },
    bundle: true,
    platform: "node",
    conditions: ["node"],
    mainFields: ["main"],
    format: "esm",
    target: "esnext",
    minify: true,
    legalComments: "eof",
    banner: { js: NATIVE_REQUIRE_BANNER },
    plugins,
    write: false,
    metafile: true,
  });
  const source = build.outputFiles?.[0]?.text;
  if (!source) throw new Error(`[node-environment] ${packageName} bundle was empty`);
  if (!build.metafile)
    throw new Error(`[node-environment] ${packageName} bundle omitted its metafile`);

  assertBundledEntry(build.metafile, entry, packageName, workingDirectory);
  assertOnlyNativeAndWasmImports(
    build.metafile,
    packageName,
    packageName === "undici"
      ? new Set(Object.values(WASM_RESOLUTIONS).map(({ importPath }) => importPath))
      : new Set<string>(),
  );
  if (undici) {
    if (transformedClientH1 !== 1) {
      throw new Error(
        `[node-environment] expected one transformed undici client-h1.js input; found ${transformedClientH1}`,
      );
    }
    assertWasmSourcesNotBundled(build.metafile, undici.wasmPaths, workingDirectory);
  }
  return source;
}

function processInteropPlugin(): Esbuild.Plugin {
  return {
    name: "signalbox-node-environment-process-interop",
    setup(build) {
      build.onResolve({ filter: /^process$/ }, () => ({
        path: "process",
        namespace: "signalbox-node-environment-process",
      }));
      build.onLoad({ filter: /.*/, namespace: "signalbox-node-environment-process" }, () => ({
        contents: 'import process from "node:process"; module.exports = process;',
        loader: "js",
      }));
    },
  };
}

function undiciWasmPlugin(options: UndiciBundleOptions, onTransform: () => void): Esbuild.Plugin {
  const packageRequire = NodeModule.createRequire(options.packageEntry);
  const clientPath = NodeFS.realpathSync(packageRequire.resolve("./lib/dispatcher/client-h1.js"));

  return {
    name: "signalbox-undici-llhttp-wasm",
    setup(build) {
      build.onResolve(
        { filter: /^signalbox:node-environment\/llhttp(?:-simd)?\.wasm$/ },
        ({ path }) => {
          if (path === UNDICI_WASM_IMPORTS.simd) {
            return { path: WASM_RESOLUTIONS[UNDICI_WASM_IMPORTS.simd].importPath, external: true };
          }
          if (path === UNDICI_WASM_IMPORTS.fallback) {
            return {
              path: WASM_RESOLUTIONS[UNDICI_WASM_IMPORTS.fallback].importPath,
              external: true,
            };
          }
          throw new Error(`[node-environment] unexpected llhttp wasm import: ${path}`);
        },
      );
      build.onLoad({ filter: /[\\/]client-h1\.js$/ }, async (args) => {
        if (NodeFS.realpathSync(args.path) !== clientPath) return;
        onTransform();
        const contents = await NodeFSP.readFile(clientPath, "utf8");
        return {
          contents: transformUndiciClientH1Source(contents),
          loader: "js",
          resolveDir: NodePath.dirname(clientPath),
        };
      });
    },
  };
}

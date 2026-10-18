// @effect-diagnostics nodeBuiltinImport:off - build and inspect temporary release fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { rebundle, rebundleClaudeRelease } from "./rebundle.ts";

const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const WORKER_NAME = "/$bunfs/root/src/plugins/functionHooks/hooks-worker/hooks-worker.js";
const ASSET_NAME = "/$bunfs/root/assets/embedded.wasm";
const LEGACY_NAME = "/$bunfs/root/lib/legacy.cjs";
const HOST_ENTRY_NAME = "signalbox/fixture-host";
const HOST_ENTRY_SPECIFIER = "signalbox:fixture-host";

const defaultEntry = () => `
import defaultValue, { namedValue } from "/$bunfs/root/lib/values.js";
import * as esmValueNamespace from "/$bunfs/root/lib/values.js";
import fsDefault from "fs";
import * as fsNamespace from "fs";
import nodeFsDefault from "node:fs";
import * as nodeFsNamespace from "node:fs";
import { basename } from "node:path";

const legacy = import.meta.require(${JSON.stringify(LEGACY_NAME)});
const workerMetadata = { HOOKS_WORKER_URL: ${JSON.stringify(WORKER_NAME)} };
export const esmNamed = namedValue;
export const esmDefault = defaultValue;
export const esmNamespace = esmValueNamespace;
export const legacyExact = legacy;
export const legacyValue = legacy.value;
export const fsDefaultImport = fsDefault;
export const fsNamespaceImport = fsNamespace;
export const nodeFsDefaultImport = nodeFsDefault;
export const nodeFsNamespaceImport = nodeFsNamespace;
export const fsRequired = import.meta.require("fs");
export const nodeFsRequired = import.meta.require("node:fs");
export const workerUrl = workerMetadata.HOOKS_WORKER_URL;
export const nativeBasename = basename("/fixture/native.txt");
`;

interface FixtureModule {
  readonly index: number;
  readonly name: string;
  readonly loader: number;
  readonly encoding: number;
  readonly format: number;
  readonly artifactPath: string;
  readonly contents: Uint8Array;
}

interface ManifestModule {
  readonly index: number;
  readonly name: string;
  readonly key: string;
  readonly loader: number;
  readonly encoding: number;
  readonly format: number;
  readonly artifacts: {
    readonly contents: { readonly path: string; readonly bytes: number; readonly sha256: string };
  };
}

async function makeExtraction(
  root: string,
  entrySource = defaultEntry(),
  workerSource = 'export const workerMarker = "separate-worker-root";\n',
) {
  const extracted = NodePath.join(root, "extracted");
  await NodeFSP.mkdir(extracted, { recursive: true });
  const modules: FixtureModule[] = [
    {
      index: 0,
      name: "/$bunfs/root/cli",
      loader: 1,
      encoding: 0,
      format: 1,
      artifactPath: "source/cli.js",
      contents: new TextEncoder().encode(entrySource),
    },
    {
      index: 1,
      name: "/$bunfs/root/lib/values.js",
      loader: 1,
      encoding: 0,
      format: 1,
      artifactPath: "source/values.js",
      contents: new TextEncoder().encode(
        'const defaultValue = Object.freeze({ kind: "esm-default" });\n' +
          "export default defaultValue;\n" +
          'export const namedValue = Object.freeze({ kind: "esm-named" });\n',
      ),
    },
    {
      index: 2,
      name: LEGACY_NAME,
      loader: 1,
      encoding: 0,
      format: 2,
      artifactPath: "source/legacy.cjs",
      contents: new TextEncoder().encode(
        "(function(exports,require,module,__filename,__dirname){\n" +
          'module.exports = { value: "legacy-cjs", filename: __filename, dirname: __dirname };\n' +
          "})",
      ),
    },
    {
      index: 3,
      name: WORKER_NAME,
      loader: 1,
      encoding: 0,
      format: 1,
      artifactPath: "source/hooks-worker.js",
      contents: new TextEncoder().encode(workerSource),
    },
    {
      index: 4,
      name: ASSET_NAME,
      loader: 5,
      encoding: 0,
      format: 0,
      artifactPath: "source/embedded.wasm",
      contents: new Uint8Array([0, 97, 115, 109, 255, 1, 2, 3]),
    },
  ];
  const manifestModules: ManifestModule[] = [];
  for (const module of modules) {
    const path = NodePath.join(extracted, module.artifactPath);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, module.contents);
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
          bytes: module.contents.byteLength,
          sha256: digest(module.contents),
        },
      },
    });
  }
  const manifest = {
    schemaVersion: 1,
    binary: { bytes: 16, sha256: digest("synthetic-claude-binary") },
    graph: { entry: 0 },
    modules: manifestModules,
  };
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { extracted, modules };
}

async function expectPathMissing(path: string) {
  await expect(NodeFSP.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("integrated Claude rebundling", () => {
  it("bundles declared environment packages and rejects the complete unsupplied package closure", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-packages-"));
    try {
      const { extracted } = await makeExtraction(
        root,
        `
        import socket from "ws";
        import {parse} from "querystring";
        export {socket, parse};
        export const fetchModule=()=>import("node-fetch");
        export const jscModule=()=>import("bun:jsc");
      `,
      );
      const missingOutput = NodePath.join(root, "missing");
      await expect(
        rebundle({
          extracted,
          output: missingOutput,
          version: "fixture",
          platform: "linux-x64",
          deferInitialization: true,
        }),
      ).rejects.toThrow("BUNDLE_ENVIRONMENT_MODULES_MISSING: bun:jsc, node-fetch, ws");
      await expectPathMissing(missingOutput);
      const packages = {
        ws: 'module.exports={stream:require("node:stream")};',
        "node-fetch": 'export {marker} from "node:stream";export default value=>value;',
        "bun:jsc":
          'export function heapStats(){throw Object.assign(new Error("Unsupported fixture runtime"),{code:"RUNTIME_UNSUPPORTED"})}',
      };
      const output = NodePath.join(root, "bundle");
      const artifact = await rebundle({
        extracted,
        output,
        version: "fixture",
        platform: "linux-x64",
        deferInitialization: true,
        layerModules: { "node:stream": 'export const marker="owned-stream";' },
        environmentPackageModules: packages,
      });
      expect(artifact.manifest.environmentPackageModules).toEqual(
        Object.fromEntries(
          Object.entries(packages).map(([name, source]) => [
            name,
            {
              bytes: new TextEncoder().encode(source).byteLength,
              sha256: digest(source),
            },
          ]),
        ),
      );
      expect(artifact.manifest.requiredHostModules).toEqual(["node:querystring"]);
      const metafile = JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "metafile.json"), "utf8"),
      );
      const outputImports = Object.values(metafile.outputs).flatMap((value) =>
        typeof value === "object" &&
        value !== null &&
        "imports" in value &&
        Array.isArray(value.imports)
          ? value.imports
          : [],
      );
      expect(outputImports.filter((value) => value.external).map((value) => value.path)).toEqual([
        "node:querystring",
      ]);
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const launcher = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      const release = launcher.launch();
      expect(release.socket.stream.marker).toBe("owned-stream");
      const fetchModule = await release.fetchModule();
      expect(fetchModule.marker).toBe("owned-stream");
      expect(fetchModule.default("fixture-body")).toBe("fixture-body");
      const jsc = await release.jscModule();
      expect(() => jsc.heapStats()).toThrow("Unsupported fixture runtime");
      expect(release.parse("a=1").a).toBe("1");
      await expect(
        rebundle({
          extracted,
          output: NodePath.join(root, "collision"),
          version: "fixture",
          platform: "linux-x64",
          layerModules: { ws: packages.ws },
          environmentPackageModules: packages,
        }),
      ).rejects.toThrow("BUNDLE_ENVIRONMENT_MODULE_DUPLICATE: ws");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("defers release and nested dynamic initialization while retaining split workers", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-deferred-"));
    const symbol = `signalbox.deferred.fixture.${NodeCrypto.randomUUID()}`;
    const touch = `globalThis[Symbol.for(${JSON.stringify(symbol)})]`;
    const hits: string[] = [];
    Reflect.set(globalThis, Symbol.for(symbol), () => {
      throw new Error("INITIALIZATION_OUTSIDE_HANDLER");
    });
    try {
      const { extracted } = await makeExtraction(
        root,
        `${touch}("entry");
        export const sourceUrl=import.meta.url;
        export const sourceFilename=import.meta.filename;
        export const sourceDirname=import.meta.dirname;
        export const worker=${JSON.stringify(WORKER_NAME)};
        export const later=()=>import(${JSON.stringify(LEGACY_NAME)});
        export const nested=()=>import(${JSON.stringify(WORKER_NAME)});`,
        `${touch}("worker");export const sourceUrl=import.meta.url;
        export const sourceFilename=import.meta.filename;
        export const sourceDirname=import.meta.dirname;
        export const later=()=>import(${JSON.stringify(LEGACY_NAME)});`,
      );
      const output = NodePath.join(root, "bundle");
      const artifact = await rebundle({
        extracted,
        output,
        version: "fixture-1",
        platform: "linux-x64",
        deferInitialization: true,
      });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      expect(artifact.manifest.mainExport).toBe("launch");
      expect(artifact.manifest.embeddedEntrypointExport).toBe("launch");
      const launcher = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      expect(typeof launcher.launch).toBe("function");
      const workerPath = artifact.manifest.embeddedEntrypoints[WORKER_NAME]!;
      const worker = await import(NodeURL.pathToFileURL(NodePath.join(output, workerPath)).href);
      expect(hits).toEqual([]);
      Reflect.set(globalThis, Symbol.for(symbol), (name: string) => hits.push(name));
      const release = launcher.launch();
      expect(launcher.launch()).toBe(release);
      expect(release.sourceUrl).toBe("file:///$bunfs/root/cli");
      expect(release.sourceFilename).toBe("/$bunfs/root/cli");
      expect(release.sourceDirname).toBe("/$bunfs/root");
      expect(hits).toEqual(["entry"]);
      const legacy = await release.later();
      expect(legacy.default.value).toBe("legacy-cjs");
      expect(await release.later()).toBe(legacy);
      const nested = await release.nested();
      expect(await nested.later()).toBe(legacy);
      expect(worker.launch()).toBe(nested);
      expect(nested.sourceUrl).toBe(NodeURL.pathToFileURL(WORKER_NAME, { windows: false }).href);
      expect(nested.sourceFilename).toBe(WORKER_NAME);
      expect(nested.sourceDirname).toBe(NodePath.posix.dirname(WORKER_NAME));
      expect(hits).toEqual(["entry", "worker"]);
      expect(
        Object.keys(artifact.manifest.modules).some((path) => path.startsWith("chunks/")),
      ).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for(symbol));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the installed module facade for dynamic require without losing bundled imports", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-require-host-"));
    const symbol = `signalbox.require.fixture.${NodeCrypto.randomUUID()}`;
    const referrers: string[] = [];
    const host = Object.freeze({ owned: true });
    const missing = new Error("PREPARED_MODULE_UNAVAILABLE");
    const moduleFacade = {
      createRequire(referrer: string) {
        referrers.push(referrer);
        return (specifier: string) => {
          if (specifier === "fs" || specifier === "node:fs") return host;
          throw missing;
        };
      },
    };
    Reflect.set(globalThis, Symbol.for(symbol), moduleFacade);
    try {
      const { extracted } = await makeExtraction(
        root,
        `
        import {createRequire} from "node:module";
        export const explicit=createRequire("/guest/explicit.js")("node:fs");
        export const internal=import.meta.require(${JSON.stringify(LEGACY_NAME)});
        export function load(specifier){return import.meta.require(specifier)}
      `,
      );
      const facade = `module.exports=globalThis[Symbol.for(${JSON.stringify(symbol)})];`;
      const output = NodePath.join(root, "bundle");
      await expect(
        rebundle({
          extracted,
          output,
          version: "fixture-1",
          platform: "linux-x64",
          layerModules: { "node:module": facade },
        }),
      ).rejects.toThrow("BUNDLE_REQUIRE_BOOTSTRAP_MISSING");
      await expectPathMissing(output);
      const result = await rebundle({
        extracted,
        output,
        version: "fixture-1",
        platform: "linux-x64",
        layerModules: { "node:module": facade },
        requireBootstrap: `globalThis[Symbol.for(${JSON.stringify(symbol)})].createRequire("/signalbox/claude.js")`,
      });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const release = await import(
        NodeURL.pathToFileURL(NodePath.join(output, result.manifest.mainModule)).href
      );
      expect(release.explicit).toBe(host);
      expect(release.load("fs")).toBe(host);
      expect(release.load("node:fs")).toBe(host);
      expect(() => release.load("./missing.js")).toThrow(missing);
      expect(release.internal.value).toBe("legacy-cjs");
      expect(referrers).toContain("/signalbox/claude.js");
      expect(referrers).toContain("/guest/explicit.js");
      expect(result.manifest.requiredHostModules).not.toContain("node:module");
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for(symbol));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("publishes reachable ESM, CJS, Worker, host facades, runtime bootstrap and assets", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-rebundle-"));
    const hostSymbol = `signalbox.rebundle.fixture.${NodeCrypto.randomUUID()}.host`;
    const registrySymbol = `signalbox.rebundle.fixture.${NodeCrypto.randomUUID()}.registry`;
    const hostObject = Object.freeze({ marker: "fixture-host-object", token: Symbol("fixture") });
    const entrySource = defaultEntry();
    const { extracted, modules } = await makeExtraction(root, entrySource);
    const output = NodePath.join(root, "bundle");
    const bootstrapPath = "runtime/bootstrap.mjs";
    const bootstrapSource = [
      'import { basename } from "node:path";',
      `const host = globalThis[Symbol.for(${JSON.stringify(hostSymbol)})];`,
      'if (!host) throw new Error("FIXTURE_HOST_OBJECT_MISSING");',
      `globalThis[Symbol.for(${JSON.stringify(registrySymbol)})] = host;`,
      'export const nativePathResult = basename("/runtime/native.txt");',
      'export default await import("../claude.js");',
      "",
    ].join("\n");
    const facade = `module.exports = globalThis[Symbol.for(${JSON.stringify(registrySymbol)})];\n`;
    const hostEntry = [
      `const host = globalThis[Symbol.for(${JSON.stringify(registrySymbol)})];`,
      'if (!host) throw new Error("FIXTURE_HOST_OBJECT_MISSING");',
      "export default host;",
      "export const marker = host.marker;",
      "",
    ].join("\n");
    Reflect.set(globalThis, Symbol.for(hostSymbol), hostObject);
    try {
      const result = await rebundle({
        extracted,
        output,
        version: "fixture-1",
        platform: "linux-x64",
        layerModules: {
          fs: facade,
          "node:fs": facade,
          [HOST_ENTRY_SPECIFIER]: hostEntry,
        },
        hostEntrypoints: { [HOST_ENTRY_NAME]: HOST_ENTRY_SPECIFIER },
        runtimeModules: { [bootstrapPath]: bootstrapSource },
      });
      const manifestSource = await NodeFSP.readFile(NodePath.join(output, "manifest.json"), "utf8");
      const moduleMapSource = await NodeFSP.readFile(
        NodePath.join(output, "module-map.json"),
        "utf8",
      );
      const manifest = JSON.parse(manifestSource);
      const moduleMap = JSON.parse(moduleMapSource);
      expect(result.artifactSha256).toBe(digest(manifestSource));
      expect(manifest.modules[bootstrapPath]?.sha256).toBe(digest(bootstrapSource));
      expect(await NodeFSP.readFile(NodePath.join(output, bootstrapPath), "utf8")).toBe(
        bootstrapSource,
      );
      expect(manifest.moduleMap.sha256).toBe(digest(moduleMapSource));
      expect(moduleMap[bootstrapPath]).toEqual({ path: bootstrapPath, type: "js" });
      expect(manifest.hostEntrypoints).toEqual({ [HOST_ENTRY_NAME]: `${HOST_ENTRY_NAME}.js` });
      const hostEntryOutput = manifest.hostEntrypoints[HOST_ENTRY_NAME];
      expect(moduleMap[hostEntryOutput]).toEqual({ path: hostEntryOutput, type: "js" });
      const hostEntryPath = NodePath.join(output, hostEntryOutput);
      const hostEntryBytes = await NodeFSP.readFile(hostEntryPath);
      expect(manifest.modules[hostEntryOutput]).toEqual({
        path: hostEntryOutput,
        type: "js",
        bytes: hostEntryBytes.byteLength,
        sha256: digest(hostEntryBytes),
      });
      expect(Object.keys(manifest.embeddedEntrypoints)).toEqual([WORKER_NAME]);
      const workerOutput = manifest.embeddedEntrypoints[WORKER_NAME];
      expect(moduleMap[workerOutput]).toEqual({ path: workerOutput, type: "js" });
      expect(await NodeFSP.readFile(NodePath.join(output, workerOutput), "utf8")).toContain(
        "separate-worker-root",
      );
      expect(manifest.sourceModules).toContain("$bunfs/root/lib/legacy.cjs");
      expect(manifest.sourceModules).toContain(
        "$bunfs/root/src/plugins/functionHooks/hooks-worker/hooks-worker.js",
      );
      expect(manifest.requiredHostModules).toContain("node:path");
      expect(manifest.requiredHostModules).not.toContain("fs");
      expect(manifest.requiredHostModules).not.toContain("node:fs");
      expect(manifest.assets[ASSET_NAME]?.bytes).toBe(modules[4]!.contents.byteLength);
      expect(manifest.assets[ASSET_NAME]?.sha256).toBe(digest(modules[4]!.contents));
      expect(
        new Uint8Array(
          await NodeFSP.readFile(NodePath.join(output, manifest.assets[ASSET_NAME].path)),
        ),
      ).toEqual(modules[4]!.contents);

      const runtime = await import(
        NodeURL.pathToFileURL(NodePath.join(output, bootstrapPath)).href
      );
      const app = runtime.default;
      const hostRuntime = await import(NodeURL.pathToFileURL(hostEntryPath).href);
      expect(hostRuntime.default).toBe(hostObject);
      expect(hostRuntime.marker).toBe(hostObject.marker);
      expect(hostRuntime.default).toBe(app.fsDefaultImport);
      expect(runtime.nativePathResult).toBe("native.txt");
      expect(app.esmNamed).toEqual({ kind: "esm-named" });
      expect(app.esmDefault).toEqual({ kind: "esm-default" });
      expect(app.esmNamespace.namedValue).toEqual({ kind: "esm-named" });
      expect(app.esmNamespace.default).toEqual({ kind: "esm-default" });
      expect(app.legacyExact).toEqual({
        value: "legacy-cjs",
        filename: LEGACY_NAME,
        dirname: "/$bunfs/root/lib",
      });
      expect(app.legacyValue).toBe("legacy-cjs");
      expect(app.fsDefaultImport).toBe(hostObject);
      expect(app.fsNamespaceImport.default).toBe(hostObject);
      expect(app.nodeFsDefaultImport).toBe(hostObject);
      expect(app.nodeFsNamespaceImport.default).toBe(hostObject);
      expect(app.fsRequired).toBe(hostObject);
      expect(app.nodeFsRequired).toBe(hostObject);
      expect(app.workerUrl).toBe(WORKER_NAME);
      expect(app.nativeBasename).toBe("native.txt");
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for(hostSymbol));
      Reflect.deleteProperty(globalThis, Symbol.for(registrySymbol));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects damaged extracted bytes and unresolved imports before publishing", async () => {
    const hashRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-rebundle-hash-"));
    try {
      const { extracted, modules } = await makeExtraction(hashRoot);
      const assetPath = NodePath.join(extracted, modules[4]!.artifactPath);
      await NodeFSP.writeFile(assetPath, new Uint8Array([1, 2, 3]));
      const output = NodePath.join(hashRoot, "bundle");
      await expect(
        rebundle({ extracted, output, version: "fixture-1", platform: "linux-x64" }),
      ).rejects.toThrow("EXTRACTION_HASH_MISMATCH");
      await expectPathMissing(output);
    } finally {
      await NodeFSP.rm(hashRoot, { recursive: true, force: true });
    }

    const importRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "claude-rebundle-import-"),
    );
    try {
      const source = 'import { absent } from "/$bunfs/root/missing.js"; export { absent };';
      const { extracted } = await makeExtraction(importRoot, source);
      const output = NodePath.join(importRoot, "existing-bundle");
      await NodeFSP.mkdir(output, { recursive: true });
      const sentinel = NodePath.join(output, "keep.txt");
      await NodeFSP.writeFile(sentinel, "existing artifact");
      await expect(
        rebundle({ extracted, output, version: "fixture-1", platform: "linux-x64" }),
      ).rejects.toThrow("BUN_IMPORT_UNRESOLVED");
      expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("existing artifact");
      expect(await NodeFSP.readdir(output)).toEqual(["keep.txt"]);
    } finally {
      await NodeFSP.rm(importRoot, { recursive: true, force: true });
    }
  });
  it("uses the shipped AJV build path and publishes an observable compatibility entry", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-ajv-pipeline-"));
    try {
      const entry = `class Base{};class Embedded extends Base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}const library={};library.Ajv=Embedded;export function caught(schema){try{new library.Ajv({strict:false}).compile(schema);return false}catch{return true}}`;
      const { extracted } = await makeExtraction(root, entry);
      const output = NodePath.join(root, "bundle");
      const artifact = await rebundleClaudeRelease({
        extracted,
        output,
        version: "2.1.302",
        platform: "linux-x64",
      });
      expect(artifact.ajv.constructors).toHaveLength(1);
      const path = artifact.manifest.hostEntrypoints["signalbox/ajv-compatibility"];
      expect(path).toBe("signalbox/ajv-compatibility.js");
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const host = await import(NodeURL.pathToFileURL(NodePath.join(output, path!)).href);
      const launcher = await import(
        NodeURL.pathToFileURL(NodePath.join(output, artifact.manifest.mainModule)).href
      );
      const release = launcher.launch();
      host.resetAjvCompatibility();
      expect(release.caught({ $dynamicRef: "#node" })).toBe(true);
      expect(() => host.assertAjvCompatibility()).toThrow();
      host.resetAjvCompatibility();
      expect(release.caught({ type: "string" })).toBe(false);
      expect(() => host.assertAjvCompatibility()).not.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects embedded worker graphs with AJV whose failure state cannot reach the host", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-worker-ajv-"));
    try {
      const worker = `class Base{};class Embedded extends Base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}const library={};library.Ajv=Embedded;export const validate=schema=>new library.Ajv({strict:false}).compile(schema);`;
      const { extracted } = await makeExtraction(
        root,
        `export const worker=${JSON.stringify(WORKER_NAME)};`,
        worker,
      );
      const output = NodePath.join(root, "bundle");
      await expect(
        rebundleClaudeRelease({ extracted, output, version: "2.1.302", platform: "linux-x64" }),
      ).rejects.toThrow("AJV_WORKER_COMPATIBILITY_UNOBSERVED");
      await expectPathMissing(output);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

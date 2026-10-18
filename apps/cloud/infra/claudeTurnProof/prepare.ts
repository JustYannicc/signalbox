// @effect-diagnostics nodeBuiltinImport:off - artifact preparation runs in Node, outside the guest.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { build, version as esbuildVersion } from "esbuild";
import { encodeAssetBundle } from "./assetBundle.ts";
import { prepareProofEnvironment } from "./prepareEnvironment.ts";
import type { ClaudeTurnProofConfig } from "./ClaudeTurnProof.ts";
import type { ModuleType } from "../isolateProbe/moduleTransport.ts";

const MAX_MODULE_MAP_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface ArtifactEntry {
  path: string;
  bytes: number;
  sha256: string;
  type?: ModuleType;
}

interface ReleaseManifest {
  mainModule: string;
  mainExport: "launch";
  release: Record<string, unknown>;
  modules: Record<string, ArtifactEntry>;
  assets: Record<string, ArtifactEntry>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entries(value: unknown, modules: boolean): Record<string, ArtifactEntry> {
  if (!record(value)) throw new Error("Missing release inventory");
  const result: Record<string, ArtifactEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Invalid release inventory entry: ${name}`);
    }
    const type = entry.type;
    if (modules && type !== "js" && type !== "cjs" && type !== "text" && type !== "wasm") {
      throw new Error(`Invalid release module type: ${name}`);
    }
    result[name] = {
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      ...(modules ? { type: type as ModuleType } : {}),
    };
  }
  return result;
}

function releaseManifest(bytes: Uint8Array): ReleaseManifest {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !record(value) ||
    typeof value.mainModule !== "string" ||
    value.mainExport !== "launch" ||
    !record(value.release)
  ) {
    throw new Error("Release must provide an explicit launch() entry point");
  }
  const modules = entries(value.modules, true);
  if (!Object.hasOwn(modules, value.mainModule)) throw new Error("Release main module is missing");
  return {
    mainModule: value.mainModule,
    mainExport: "launch",
    release: value.release,
    modules,
    assets: entries(value.assets, false),
  };
}

function within(root: string, path: string) {
  const resolved = NodePath.resolve(root, path);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("../") || relative === ".." || NodePath.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes its directory: ${path}`);
  }
  return resolved;
}

async function verifiedBytes(root: string, entry: ArtifactEntry) {
  const bytes = await NodeFSP.readFile(within(root, entry.path));
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Artifact integrity mismatch: ${entry.path}`);
  }
  return bytes;
}

export async function prepareClaudeTurnProof(options: {
  releaseDir: string;
  outputDir: string;
  seedAssets?: boolean;
  assetsOnly?: boolean;
  packagesOnly?: boolean;
  scenario?: "boot" | "tools";
  contextTokenEquivalent?: 50_000 | 200_000;
}) {
  if (options.assetsOnly && options.packagesOnly)
    throw new Error("Choose assets-only or packages-only");
  const artifactRoot = NodePath.resolve(options.releaseDir);
  const outputRoot = NodePath.resolve(options.outputDir);
  // Reserving a fresh directory prevents a failed rerun from mutating prior evidence.
  await NodeFSP.mkdir(outputRoot);
  const manifestBytes = await NodeFSP.readFile(NodePath.join(artifactRoot, "manifest.json"));
  const manifest = releaseManifest(manifestBytes);
  const assets: ClaudeTurnProofConfig["assets"] = Object.fromEntries(
    Object.entries(manifest.assets).map(([path, entry]) => [
      path,
      { bytes: entry.bytes, sha256: entry.sha256 },
    ]),
  );
  const pins = {
    release: manifest.release,
    releaseManifestSha256: sha256(manifestBytes),
    esbuildVersion,
  };
  const seedAssets = options.seedAssets === true || options.assetsOnly === true;
  const environment = options.assetsOnly ? undefined : await prepareProofEnvironment();
  const environmentModules = [
    ...(environment?.workerModules ?? []).map((module) => ({
      path: module.path,
      type: module.type,
      bytes: new TextEncoder().encode(module.source),
    })),
    ...(environment?.startupWasm ?? []),
  ];
  const environmentInventory = environmentModules.map((module) => ({
    path: module.path,
    type: module.type,
    bytes: module.bytes.byteLength,
    sha256: sha256(module.bytes),
  }));
  const reservedNames = new Set(["proof-host.js"]);
  for (const module of environmentModules) {
    if (reservedNames.has(module.path) || Object.hasOwn(manifest.modules, module.path))
      throw new Error(`Release conflicts with environment module name: ${module.path}`);
    reservedNames.add(module.path);
  }
  const loadRelease =
    options.assetsOnly || options.packagesOnly
      ? 'async()=>{throw new Error("ERR_DIAGNOSTIC_ASSETS_ONLY");}'
      : `()=>import(${JSON.stringify(`./${manifest.mainModule}`)})`;
  const loadPackages =
    environment === undefined
      ? 'async()=>{throw new Error("ERR_DIAGNOSTIC_ASSETS_ONLY");}'
      : `async()=>{const[yaml,undici]=await Promise.all([import(${JSON.stringify(`./${environment.packageEntrypoints.yaml}`)}),import(${JSON.stringify(`./${environment.packageEntrypoints.undici}`)})]);return {yaml:yaml.default,undici:undici.default};}`;
  const runtime = NodePath.join(import.meta.dirname, "ClaudeTurnProof.ts");
  const source = `import {createClaudeTurnProofClass} from ${JSON.stringify(runtime)};
export const ClaudeTurnProof=createClaudeTurnProofClass({assets:${JSON.stringify(assets)},pins:${JSON.stringify(pins)},requireSeed:${seedAssets},assetsOnly:${options.assetsOnly === true},packagesOnly:${options.packagesOnly === true},loadPackages:${loadPackages},scenario:${JSON.stringify(options.scenario ?? "boot")},contextTokenEquivalent:${options.contextTokenEquivalent ?? "undefined"},loadRelease:${loadRelease}});`;
  const bundled = await build({
    stdin: {
      contents: source,
      resolveDir: import.meta.dirname,
      sourcefile: "proof-entry.ts",
      loader: "ts",
    },
    outfile: NodePath.join(outputRoot, "proof-host.js"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minifyWhitespace: true,
    external: [
      "node:*",
      "cloudflare:*",
      `./${manifest.mainModule}`,
      ...Object.values(environment?.packageEntrypoints ?? {}).map((path) => `./${path}`),
    ],
  });
  const host = bundled.outputFiles[0];
  if (!host || bundled.outputFiles.length !== 1)
    throw new Error("Proof runtime did not emit exactly one host module");
  if (Object.hasOwn(manifest.modules, "proof-host.js"))
    throw new Error("Release conflicts with proof host module name");
  const releaseBytes = Object.values(manifest.modules).reduce((sum, entry) => sum + entry.bytes, 0);
  const environmentBytes = environmentInventory.reduce((sum, module) => sum + module.bytes, 0);
  const moduleMapBytes = releaseBytes + host.contents.byteLength + environmentBytes;
  if (moduleMapBytes > MAX_MODULE_MAP_BYTES) {
    throw new Error(
      `Module map requires ${moduleMapBytes} bytes; budget is ${MAX_MODULE_MAP_BYTES}`,
    );
  }
  const modules: Record<string, { path: string; type: ModuleType }> = {};
  for (const [name, entry] of Object.entries(manifest.modules)) {
    const bytes = await verifiedBytes(artifactRoot, entry);
    const path = NodePath.join("release", entry.path);
    const target = within(outputRoot, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, bytes);
    modules[name] = { path, type: entry.type! };
  }
  for (const module of environmentModules) {
    const path = NodePath.join("environment", module.path);
    const destination = within(outputRoot, path);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, module.bytes);
    modules[module.path] = { path, type: module.type };
  }
  for (const module of environment?.raw.workerModules ?? []) {
    const path = within(outputRoot, NodePath.join("environment-raw", module.path));
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, module.source);
  }
  for (const module of environment?.raw.startupWasm ?? []) {
    const path = within(outputRoot, NodePath.join("environment-raw", module.path));
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, module.bytes);
  }
  if (environment)
    await NodeFSP.writeFile(
      NodePath.join(outputRoot, "environment-provenance.json"),
      `${JSON.stringify(environment.provenance, null, 2)}\n`,
    );
  const bundleEntries = [];
  for (const [path, entry] of Object.entries(manifest.assets)) {
    bundleEntries.push({
      path,
      bytes: await verifiedBytes(artifactRoot, entry),
      sha256: entry.sha256,
    });
  }
  const assetBundle = encodeAssetBundle(bundleEntries);
  await NodeFSP.writeFile(NodePath.join(outputRoot, "assets.bundle"), assetBundle);
  await NodeFSP.writeFile(NodePath.join(outputRoot, "proof-host.js"), host.contents);
  modules["proof-host.js"] = { path: "proof-host.js", type: "js" };
  const requests = seedAssets
    ? {
        requests: [
          {
            path: "/seed-assets",
            method: "POST",
            bodyFile: "assets.bundle",
            contentType: "application/vnd.signalbox.claude-assets.v1",
          },
          {
            path: options.assetsOnly
              ? "/verify-assets"
              : options.packagesOnly
                ? "/verify-packages"
                : "/boot",
            method: "GET",
          },
        ],
      }
    : { paths: [options.packagesOnly ? "/verify-packages" : "/boot"] };
  await NodeFSP.writeFile(
    NodePath.join(outputRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: "claude-turn-proof",
        mode: "facet",
        allowOutbound: false,
        mainModule: "proof-host.js",
        entrypoint: "ClaudeTurnProof",
        modules,
        ...requests,
      },
      null,
      2,
    )}\n`,
  );
  const summary = {
    pins,
    moduleCount: Object.keys(modules).length,
    moduleMapBytes,
    moduleMapBudget: MAX_MODULE_MAP_BYTES,
    hostSha256: sha256(host.contents),
    hostBytes: host.contents.byteLength,
    assetCount: bundleEntries.length,
    assetBytes: bundleEntries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
    assetBundleBytes: assetBundle.byteLength,
    assetBundleSha256: sha256(assetBundle),
    seeded: seedAssets,
    assetsOnly: options.assetsOnly === true,
    packagesOnly: options.packagesOnly === true,
    ...(environment
      ? {
          environment: {
            bytes: environmentBytes,
            modules: environmentInventory,
            provenanceSha256: sha256(
              new TextEncoder().encode(JSON.stringify(environment.provenance, null, 2) + "\n"),
            ),
          },
        }
      : {}),
  };
  await NodeFSP.writeFile(
    NodePath.join(outputRoot, "preparation.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

if (process.argv[1] === import.meta.filename) {
  const { values } = NodeUtil.parseArgs({
    options: {
      release: { type: "string" },
      output: { type: "string" },
      "seed-assets": { type: "boolean", default: false },
      "assets-only": { type: "boolean", default: false },
      "packages-only": { type: "boolean", default: false },
      scenario: { type: "string", default: "boot" },
      "context-token-equivalent": { type: "string" },
    },
  });
  if (!values.release || !values.output)
    throw new Error("Pass --release <artifact> --output <fresh-directory>");
  const scenario = values.scenario;
  if (scenario !== "boot" && scenario !== "tools")
    throw new Error("scenario must be boot or tools");
  const tokens = values["context-token-equivalent"];
  if (tokens !== undefined && tokens !== "50000" && tokens !== "200000")
    throw new Error("context-token-equivalent must be50000 or200000");
  process.stdout.write(
    `${JSON.stringify(
      await prepareClaudeTurnProof({
        releaseDir: values.release,
        outputDir: values.output,
        seedAssets: values["seed-assets"],
        assetsOnly: values["assets-only"],
        packagesOnly: values["packages-only"],
        scenario,
        ...(tokens === undefined
          ? {}
          : { contextTokenEquivalent: tokens === "50000" ? 50_000 : 200_000 }),
      }),
    )}\n`,
  );
}

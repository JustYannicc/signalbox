import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import { canonicalNodeBuiltin, NODE_BUILTIN_ROUTES } from "./NodeBuiltinMap.ts";
import { createNodeBridgeLayerModules } from "./NodeBridge.ts";

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";
const GUEST_MODULE_PATH = "/sdk.mjs";
const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface NpmSdkSource {
  readonly root: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly name: string;
  readonly version: string;
}

export interface VerifiedNpmSdkSource {
  readonly root: string;
  readonly source: NpmSdkSource;
  readonly tarballSha256: string;
  readonly tarballBytes: number;
  verifyFile(file: string): Promise<{
    readonly packageName: string;
    readonly packageVersion: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
}

export interface NodeSdkSourceTransform {
  readonly contents: string;
  readonly rewrittenCalls: number;
}

export interface NodeSdkBuildOptions {
  readonly source: VerifiedNpmSdkSource;
  readonly dependencies?: ReadonlyArray<VerifiedNpmSdkSource>;
  readonly nodeModulesRoot?: string;
  readonly output: string;
  readonly transformSource?: (source: string, file: string) => NodeSdkSourceTransform;
}

function containsPath(root: string, candidate: string) {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

function selectOwner(sources: ReadonlyArray<VerifiedNpmSdkSource>, file: string) {
  return sources
    .filter((source) => containsPath(source.root, file))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

async function recheckArchives(sources: ReadonlyArray<VerifiedNpmSdkSource>) {
  const checks = await Promise.allSettled(
    sources.map(async (source) => {
      const bytes = await NodeFSP.readFile(source.source.tarball);
      const integrity = `sha512-${NodeCrypto.createHash("sha512").update(bytes).digest("base64")}`;
      if (
        integrity !== source.source.integrity ||
        bytes.byteLength !== source.tarballBytes ||
        sha256(bytes) !== source.tarballSha256
      )
        throw new Error("NODE_SDK_NPM_ARCHIVE_CHANGED");
    }),
  );
  const failure = checks.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

function npmSources(sources: ReadonlyArray<VerifiedNpmSdkSource>) {
  const records = new Map<
    string,
    {
      name: string;
      version: string;
      integrity: string;
      tarballSha256: string;
      tarballBytes: number;
    }
  >();
  for (const item of sources) {
    const record = {
      name: item.source.name,
      version: item.source.version,
      integrity: item.source.integrity,
      tarballSha256: item.tarballSha256,
      tarballBytes: item.tarballBytes,
    };
    const key = `${record.name}@${record.version}`;
    const previous = records.get(key);
    if (
      previous &&
      (previous.integrity !== record.integrity || previous.tarballSha256 !== record.tarballSha256)
    )
      throw new Error("NODE_SDK_DEPENDENCY_PIN_CONFLICT");
    records.set(key, record);
  }
  return [...records.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

/** Build one closed ESM module whose initialize() binds a fresh SDK closure to the host bridge. */
export async function buildNodeSdk(input: NodeSdkBuildOptions) {
  if (input.source.source.name !== SDK_NAME) throw new Error("NODE_SDK_OFFICIAL_PACKAGE_REQUIRED");
  const verified = [input.source, ...(input.dependencies ?? [])];
  if (new Set(verified.map((source) => source.root)).size !== verified.length)
    throw new Error("NODE_SDK_SOURCE_ROOT_DUPLICATE");
  if (
    input.source.source.name !== SDK_NAME ||
    verified.some((source) => !source.source.name || !source.source.version)
  )
    throw new Error("NODE_SDK_SOURCE_IDENTITY_INVALID");
  const packageManifest: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(verified[0]!.root, "package.json"), "utf8"),
  );
  const main: unknown =
    typeof packageManifest === "object" && packageManifest !== null
      ? Reflect.get(packageManifest, "main")
      : undefined;
  if (typeof main !== "string" || NodePath.isAbsolute(main) || main.split(/[\\/]/u).includes(".."))
    throw new Error("NODE_SDK_MAIN_ENTRY_INVALID");

  const directory = NodePath.resolve(input.output);
  const modulesRoot = input.nodeModulesRoot && NodePath.resolve(input.nodeModulesRoot);
  if (
    verified.some(
      (source) => containsPath(source.root, directory) || containsPath(directory, source.root),
    ) ||
    (modulesRoot && (containsPath(modulesRoot, directory) || containsPath(directory, modulesRoot)))
  )
    throw new Error("NODE_SDK_OUTPUT_OVERLAPS_INPUT");

  const facades = createNodeBridgeLayerModules(
    Object.keys(NODE_BUILTIN_ROUTES).filter(
      (name): name is keyof typeof NODE_BUILTIN_ROUTES => canonicalNodeBuiltin(name) !== undefined,
    ),
  );
  const builtins = new Set<string>();
  let createRequireRewrites = 0;
  const result = await Esbuild.build({
    absWorkingDir: verified[0]!.root,
    entryPoints: [NodePath.join(verified[0]!.root, main)],
    ...(modulesRoot ? { nodePaths: [modulesRoot] } : {}),
    bundle: true,
    format: "cjs",
    banner: {
      js: "export function initialize(){const module={exports:{}};const exports=module.exports;",
    },
    footer: { js: "return module.exports;}" },
    platform: "node",
    target: "es2022",
    minify: true,
    legalComments: "eof",
    write: false,
    metafile: true,
    define: {
      "import.meta.url": JSON.stringify(`file://${GUEST_MODULE_PATH}`),
      "import.meta.dirname": JSON.stringify(NodePath.posix.dirname(GUEST_MODULE_PATH)),
      "import.meta.filename": JSON.stringify(GUEST_MODULE_PATH),
      __dirname: JSON.stringify(NodePath.posix.dirname(GUEST_MODULE_PATH)),
      __filename: JSON.stringify(GUEST_MODULE_PATH),
    },
    plugins: [
      {
        name: "installed-node-personality",
        setup(build) {
          build.onResolve({ filter: /^(?:node:)?[a-z0-9_]+(?:\/[a-z0-9_]+)?$/ }, (args) => {
            const name = canonicalNodeBuiltin(args.path);
            if (name === undefined) return;
            builtins.add(name);
            return { path: name, namespace: "node-personality" };
          });
          build.onLoad({ filter: /.*/, namespace: "node-personality" }, (args) => ({
            contents: facades[args.path]!,
            loader: "js",
          }));
          build.onLoad({ filter: /\.[cm]?js$/, namespace: "file" }, async (args) => {
            const source = await NodeFSP.readFile(args.path, "utf8");
            if (!input.transformSource || !source.includes("createRequire"))
              return { contents: source, loader: "js", resolveDir: NodePath.dirname(args.path) };
            const transformed = input.transformSource(source, args.path);
            createRequireRewrites += transformed.rewrittenCalls;
            return {
              contents: transformed.contents,
              loader: "js",
              resolveDir: NodePath.dirname(args.path),
            };
          });
        },
      },
    ],
  });

  const output = result.outputFiles?.[0]?.contents;
  const metafile = result.metafile;
  if (!output || !metafile) throw new Error("NODE_SDK_BUNDLE_EMPTY");
  const external = Object.values(metafile.outputs).flatMap((entry) =>
    entry.imports.filter((item) => item.external).map((item) => item.path),
  );
  if (external.length > 0) throw new Error("NODE_SDK_EXTERNAL_IMPORT_REMAINS");

  const sourceFiles = [];
  for (const file of Object.keys(metafile.inputs)) {
    if (file.startsWith("node-personality:")) continue;
    const absolute = await NodeFSP.realpath(NodePath.resolve(verified[0]!.root, file));
    const owner = selectOwner(verified, absolute);
    if (!owner) throw new Error("NODE_SDK_UNDECLARED_DEPENDENCY_INPUT");
    sourceFiles.push(await owner.verifyFile(absolute));
  }
  await recheckArchives(verified);
  sourceFiles.sort((left, right) =>
    `${left.packageName}/${left.path}`.localeCompare(`${right.packageName}/${right.path}`),
  );

  const moduleBytes = Uint8Array.from(output);
  const moduleName = "sdk.mjs";
  const moduleMapBytes = Buffer.from(
    `${JSON.stringify({ [moduleName]: { path: moduleName, type: "js" } }, null, 2)}\n`,
  );
  const manifest = {
    schemaVersion: 1,
    release: {
      provider: "agent-sdk",
      name: SDK_NAME,
      version: input.source.source.version,
      integrity: input.source.source.integrity,
      tarballSha256: verified[0]!.tarballSha256,
    },
    mainModule: moduleName,
    initializeExport: "initialize",
    modules: {
      [moduleName]: {
        path: moduleName,
        type: "js",
        bytes: moduleBytes.byteLength,
        sha256: sha256(moduleBytes),
      },
    },
    assets: {},
    requiredHostModules: [...builtins].sort(),
    moduleMap: { path: "module-map.json", sha256: sha256(moduleMapBytes) },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await NodeFSP.mkdir(NodePath.dirname(directory), { recursive: true });
  try {
    await NodeFSP.mkdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("NODE_SDK_OUTPUT_EXISTS", { cause: error });
    throw error;
  }
  await NodeFSP.writeFile(NodePath.join(directory, moduleName), moduleBytes, { flag: "wx" });
  await NodeFSP.writeFile(NodePath.join(directory, "module-map.json"), moduleMapBytes, {
    flag: "wx",
  });
  await NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), manifestBytes, {
    flag: "wx",
  });

  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    sourceFiles,
    npmSources: npmSources(verified),
    esbuildVersion: Esbuild.version,
    inputCount: Object.keys(metafile.inputs).length,
    createRequireRewrites,
  };
}

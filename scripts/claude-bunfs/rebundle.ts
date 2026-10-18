// Reuses codex-wasi-agentos's esbuild lazy-init approach at 45eca7daf24bbac603689cc3229693310d184e51.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - build-time release transformation and CLI output.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { readExtraction } from "./extracted-input.ts";
import { normalizeModule } from "./normalize.ts";
import { publishBundle, type EmbeddedAsset } from "./bundle-artifact.ts";
import { discoverEmbeddedModuleReferences } from "./embedded-entrypoints.ts";
import { createDeferredInitialization } from "./deferred-initialization.ts";

export interface RebundleOptions {
  readonly extracted: string;
  readonly output: string;
  readonly version: string;
  readonly platform: string;
  /** Pass the same object if transform adds modules while the graph loads. */
  readonly layerModules?: Readonly<Record<string, string>>;
  /** Prepared real package sources keyed by their exact import specifiers. */
  readonly environmentPackageModules?: Readonly<Record<string, string>>;
  /** Stable host entry names mapped to virtual layer modules. Names omit the .js extension. */
  readonly hostEntrypoints?: Readonly<Record<string, string>>;
  /** Prebundled host/bootstrap modules, kept outside release import remapping. */
  readonly runtimeModules?: Readonly<Record<string, string>>;
  /** Expression returning dynamic require from the installed host module facade. */
  readonly requireBootstrap?: string;
  /** Importing the output defines launch(); release initialization runs when it is called. */
  readonly deferInitialization?: boolean;
  readonly verify?: (
    metafile: Esbuild.Metafile,
    embeddedEntrypoints: Readonly<Record<string, string>>,
  ) => void;
  readonly transform?: (module: {
    key: string;
    name: string;
    source: string;
    format: number;
  }) => Promise<string>;
}

export async function rebundle(options: RebundleOptions) {
  for (const name of Object.keys(options.environmentPackageModules ?? {}))
    if (Object.hasOwn(options.layerModules ?? {}, name))
      throw new Error(`BUNDLE_ENVIRONMENT_MODULE_DUPLICATE: ${name}`);
  const moduleFacade = ["module", "node:module"].some((name) =>
    Object.hasOwn(options.layerModules ?? {}, name),
  );
  if (moduleFacade && !options.requireBootstrap?.trim())
    throw new Error("BUNDLE_REQUIRE_BOOTSTRAP_MISSING");
  const input = await readExtraction(options.extracted);
  const javascript = input.manifest.modules.filter((module) => module.loader === 1);
  const decoded = [];
  for (const module of javascript)
    decoded.push({ name: module.name, source: await input.readSource(module) });
  const embeddedReferences = discoverEmbeddedModuleReferences(
    decoded,
    new Set(javascript.map((module) => module.name)),
  );
  const sourceByName = new Map(decoded.map((module) => [module.name, module.source]));
  const deferred = options.deferInitialization ? createDeferredInitialization() : undefined;
  const deferSource = (source: string, importer: string) =>
    deferred
      ? deferred.transform(source, importer, (specifier, referrer) => {
          if (Object.hasOwn(options.layerModules ?? {}, specifier)) return specifier;
          if (Object.hasOwn(options.environmentPackageModules ?? {}, specifier)) return specifier;
          const name = specifier.startsWith(".")
            ? NodePath.posix.resolve(NodePath.posix.dirname(referrer), specifier)
            : specifier;
          return (input.byName.get(name) ?? input.byKey.get(name))?.name;
        })
      : source;
  const entries: Record<string, string> = {
    claude: deferred?.entry(input.entry.name) ?? input.entry.name,
  };
  const embeddedEntrypoints: Record<string, string> = {};
  for (const target of [
    ...new Set(embeddedReferences.map((reference) => reference.target)),
  ].sort()) {
    if (target === input.entry.name) continue;
    const name = `workers/${NodeCrypto.createHash("sha256").update(target).digest("hex").slice(0, 24)}`;
    entries[name] = deferred?.entry(target) ?? target;
    embeddedEntrypoints[target] = `${name}.js`;
  }
  const hostEntrypoints: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(options.hostEntrypoints ?? {})) {
    if (Object.hasOwn(entries, name)) throw new Error(`BUNDLE_ENTRY_DUPLICATE: ${name}`);
    entries[name] = specifier;
    hostEntrypoints[name] = `${name}.js`;
  }
  const loaded = new Set<string>();
  const requiredHostModules = new Set<string>();
  const builtins = new Set(NodeModule.builtinModules.flatMap((name) => [name, `node:${name}`]));
  const output = NodePath.resolve(options.output);
  const result = await Esbuild.build({
    entryPoints: entries,
    outdir: output,
    entryNames: "[dir]/[name]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    minifyWhitespace: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    metafile: true,
    supported: { using: false },
    legalComments: "inline",
    logLevel: "silent",
    banner: {
      // Worker Loader does not populate import.meta.url. Internal graph requires are bundled.
      // esbuild inserts banners after resolution; a module facade needs its own host bootstrap.
      js: options.requireBootstrap
        ? `const require=(${options.requireBootstrap});`
        : 'import { createRequire as __signalboxCreateRequire } from "node:module";const require=__signalboxCreateRequire("/signalbox/claude.js");',
    },
    plugins: [
      ...(deferred ? [deferred.plugin] : []),
      {
        name: "bun-extracted-graph",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (options.layerModules && Object.hasOwn(options.layerModules, args.path))
              return { path: args.path, namespace: "signalbox-layer" };
            if (Object.hasOwn(options.environmentPackageModules ?? {}, args.path))
              return { path: args.path, namespace: "signalbox-environment-package" };
            if (builtins.has(args.path)) {
              const name = args.path.startsWith("node:") ? args.path : `node:${args.path}`;
              requiredHostModules.add(name);
              return { path: name, external: true };
            }
            // Keep scanning so one rejected build reports the complete missing package set.
            if (args.path === "ws" || args.path === "node-fetch" || args.path.startsWith("bun:")) {
              requiredHostModules.add(args.path);
              return { path: args.path, external: true };
            }
            const name = args.path.startsWith(".")
              ? NodePath.posix.resolve(NodePath.posix.dirname(args.importer), args.path)
              : args.path;
            const module = input.byName.get(name) ?? input.byKey.get(name);
            if (!module)
              throw new Error(`BUN_IMPORT_UNRESOLVED: ${args.importer || "<entry>"}: ${args.path}`);
            return { path: module.name, namespace: "bun-graph" };
          });
          build.onLoad({ filter: /.*/, namespace: "signalbox-layer" }, (args) => ({
            contents: deferSource(options.layerModules![args.path]!, args.path),
            loader: "js",
          }));
          build.onLoad({ filter: /.*/, namespace: "signalbox-environment-package" }, (args) => ({
            contents: deferSource(options.environmentPackageModules![args.path]!, args.path),
            loader: "js",
          }));
          build.onLoad({ filter: /.*/, namespace: "bun-graph" }, async (args) => {
            const module = input.byName.get(args.path)!;
            const key = module.key ?? module.name.replace(/^\/+/, "");
            loaded.add(key);
            if (module.loader === 1) {
              const normalized = normalizeModule({
                name: module.name,
                key,
                source: sourceByName.get(module.name)!,
                format: module.format,
                isEntry: module.index === input.manifest.graph.entry,
              });
              const source = options.transform
                ? await options.transform(normalized)
                : normalized.source;
              return {
                contents: deferSource(source, module.name),
                loader: "js",
              };
            }
            if (module.loader === 13) {
              const bytes = await input.readContents(module);
              const text =
                module.encoding === 2 ? bytes.toString("utf16le") : bytes.toString("latin1");
              return { contents: text, loader: "text" };
            }
            if (module.loader === 5) {
              return { contents: `export default ${JSON.stringify(module.name)};`, loader: "js" };
            }
            throw new Error(`BUN_LOADER_REQUIRES_HOST: ${module.name}: loader ${module.loader}`);
          });
        },
      },
    ],
  });
  const missingPackages = [
    ...new Set(
      Object.values(result.metafile.outputs).flatMap((output) =>
        output.imports
          .filter((dependency) => dependency.external && !builtins.has(dependency.path))
          .map((dependency) => dependency.path),
      ),
    ),
  ].sort();
  if (missingPackages.length)
    throw new Error(`BUNDLE_ENVIRONMENT_MODULES_MISSING: ${missingPackages.join(", ")}`);
  options.verify?.(result.metafile, embeddedEntrypoints);
  const embeddedAssets: EmbeddedAsset[] = [];
  // Bun.file can read embedded assets without a JavaScript import. Preserve the full asset map.
  for (const module of input.manifest.modules) {
    if (module.loader === 1) continue;
    const contents = await input.readContents(module);
    const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
    embeddedAssets.push({
      name: module.name,
      key: module.key ?? module.name.replace(/^\/+/, ""),
      loader: module.loader,
      encoding: module.encoding,
      path: `assets/${module.index}-${sha256}`,
      contents,
    });
  }
  return publishBundle({
    output,
    release: {
      provider: "claude-code",
      version: options.version,
      platform: options.platform,
      binarySha256: input.manifest.binary.sha256,
    },
    mainModule: "claude.js",
    ...(deferred ? ({ mainExport: "launch", embeddedEntrypointExport: "launch" } as const) : {}),
    environmentPackageModules: options.environmentPackageModules ?? {},
    embeddedEntrypoints,
    hostEntrypoints,
    modules: [
      ...result.outputFiles.map((file) => ({
        path: NodePath.relative(output, file.path).split(NodePath.sep).join("/"),
        contents: file.contents,
      })),
      ...Object.entries(options.runtimeModules ?? {}).map(([path, source]) => ({
        path,
        contents: new TextEncoder().encode(source),
      })),
    ],
    assets: embeddedAssets,
    requiredHostModules: [...requiredHostModules],
    sourceModules: [...loaded],
    metafile: result.metafile,
  });
}

/** The shipped build path always installs the bounded AJV layer. */
export async function rebundleClaudeRelease(
  options: Omit<RebundleOptions, "transform" | "verify">,
) {
  const { createAjvRebundleTransform } = await import("./rebundle-ajv.ts");
  const layer = await createAjvRebundleTransform();
  for (const [name, source] of Object.entries(options.layerModules ?? {})) {
    if (Object.hasOwn(layer.layerModules, name)) throw new Error(`BUNDLE_LAYER_DUPLICATE: ${name}`);
    layer.layerModules[name] = source;
  }
  const artifact = await rebundle({
    ...options,
    deferInitialization: options.deferInitialization ?? true,
    ...layer,
    hostEntrypoints: { ...options.hostEntrypoints, ...layer.hostEntrypoints },
  });
  return { ...artifact, ajv: layer.report() };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [extracted, output, version, platform] = process.argv.slice(2);
  if (!extracted || !output || !version || !platform)
    throw new Error("Usage: rebundle.ts <extracted> <new-output> <version> <platform>");
  console.log(
    JSON.stringify(await rebundleClaudeRelease({ extracted, output, version, platform })),
  );
}

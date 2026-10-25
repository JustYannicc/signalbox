// Reuses codex-wasi-agentos's esbuild lazy-init approach at 45eca7daf24bbac603689cc3229693310d184e51.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - build-time release transformation and CLI output.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { readExtraction } from "./extracted-input.ts";
import { publishBundle, type BundleFile, type EmbeddedAsset } from "./bundle-artifact.ts";
import { discoverEmbeddedModuleReferences } from "./embedded-entrypoints.ts";
import { createDeferredInitialization } from "./deferred-initialization.ts";
import { entryExports, planSingleModule } from "./single-module.ts";
import {
  HOOKS_WORKER_ENTRY,
  hooksWorkerEntries,
  workerInputClosure,
  packWorkerPartition,
} from "./worker-partition.ts";
import { assertOneByteModules, inlineLegalNotices } from "./one-byte-output.ts";
import { type BunGraphOptions, createBunGraphPlugin, NODE_BUILTINS } from "./bun-graph-plugin.ts";
import { createReleaseOmission } from "./rebundle-omission.ts";
import type { ReleaseOmissionOptions } from "./release-omission.ts";
import {
  parsePinnedEnvironmentSourceId,
  pinnedEnvironmentSourceId,
} from "./pinned-environment-origin.ts";

export interface RebundleOptions extends BunGraphOptions {
  readonly omission?: ReleaseOmissionOptions;
  readonly partitionHooksWorker?: boolean;
  readonly extracted: string;
  readonly output: string;
  readonly version: string;
  readonly platform: string;
  /**
   * Stable host entry names mapped to virtual layer modules. Names omit the .js extension.
   * Deferred builds publish entries as snapshot facades, so they must export functions or constants.
   */
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
  let workerInputs = new Set<string>();
  const retainWorker = (metafile: Esbuild.Metafile) => {
    workerInputs = workerInputClosure(metafile, HOOKS_WORKER_ENTRY);
    return workerInputs;
  };
  const omission = options.omission
    ? createReleaseOmission({
        options: options.omission,
        ...(options.partitionHooksWorker ? { retainWorker } : {}),
        binarySha256: input.manifest.binary.sha256,
        sources: sourceByName,
        resolve: (specifier, importer) => {
          const location = parsePinnedEnvironmentSourceId(importer);
          if (Object.hasOwn(options.layerModules ?? {}, specifier))
            return pinnedEnvironmentSourceId("signalbox-layer", specifier);
          if (Object.hasOwn(options.environmentPackageModules ?? {}, specifier))
            return pinnedEnvironmentSourceId("signalbox-environment-package", specifier);
          const name = specifier.startsWith(".")
            ? NodePath.posix.resolve(NodePath.posix.dirname(location.path), specifier)
            : specifier;
          const module = input.byName.get(name) ?? input.byKey.get(name);
          return module ? pinnedEnvironmentSourceId("bun-graph", module.name) : undefined;
        },
        commonJs: (path) => input.byName.get(path)?.format === 2,
      })
    : undefined;
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
  let packing = false;
  const graph = createBunGraphPlugin({
    extraction: input,
    sources: sourceByName,
    options,
    deferSource,
    ...(omission ? { observeSource: omission.observeSource } : {}),
    prepareSource: (source, path, namespace) => {
      const prepared = omission?.prepareSource(source, path, namespace) ?? source;
      return packing && deferred ? deferred.linkDynamicImports(prepared, path) : prepared;
    },
  });
  const { loaded, requiredHostModules } = graph;
  const output = NodePath.resolve(options.output);
  const shared = {
    outdir: output,
    entryNames: "[dir]/[name]",
    bundle: true,
    minifyWhitespace: true,
    ...(omission ? { minifySyntax: true, treeShaking: true } : {}),
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    metafile: true,
    supported: { using: false },
    legalComments: "external",
    logLevel: "silent",
    banner: {
      // Worker Loader does not populate import.meta.url. Internal graph requires are bundled.
      // esbuild inserts banners after resolution; a module facade needs its own host bootstrap.
      js: options.requireBootstrap
        ? `const require=(${options.requireBootstrap});`
        : 'import { createRequire as __signalboxCreateRequire } from "node:module";const require=__signalboxCreateRequire("/signalbox/claude.js");',
    },
  } satisfies Esbuild.BuildOptions;
  // Split output still drives verification: lazy __esm init follows static reachability, so each
  // entry's split graph is what that entry evaluates.
  const buildSplit = () =>
    Esbuild.build({
      ...shared,
      entryPoints: entries,
      chunkNames: "chunks/[name]-[hash]",
      splitting: true,
      plugins: [...(deferred ? [deferred.plugin] : []), graph.plugin],
    });
  const split = await (omission ? omission.plan(buildSplit) : buildSplit());
  const missingPackages = [
    ...new Set(
      Object.values(split.metafile.outputs).flatMap((output) =>
        output.imports
          .filter((dependency) => dependency.external && !NODE_BUILTINS.has(dependency.path))
          .map((dependency) => dependency.path),
      ),
    ),
  ].sort();
  if (missingPackages.length)
    throw new Error(`BUNDLE_ENVIRONMENT_MODULES_MISSING: ${missingPackages.join(", ")}`);
  options.verify?.(split.metafile, embeddedEntrypoints);
  if (options.partitionHooksWorker && !omission) retainWorker(split.metafile);
  let published: { metafile: Esbuild.Metafile; outputFiles: BundleFile[] } = split;
  let facades: BundleFile[] = [];
  let workerFactory: Awaited<ReturnType<typeof packWorkerPartition>>["factory"] | undefined;
  if (options.partitionHooksWorker) {
    if (!deferred) throw new Error("BUNDLE_WORKER_DEFERRED_REQUIRED");
    const workerEntry = embeddedEntrypoints[HOOKS_WORKER_ENTRY];
    if (!workerEntry) throw new Error(`BUNDLE_WORKER_ENTRY_MISSING: ${HOOKS_WORKER_ENTRY}`);
    const single = planSingleModule({
      mainEntry: "claude",
      entries,
      exports: entryExports(split.metafile, output, entries),
    });
    packing = true;
    const packed = await packWorkerPartition({
      output,
      main: single,
      workerEntry,
      workerSpecifier: entries[workerEntry.slice(0, -3)]!,
      workerInputs,
      shared,
      plugins: [single.plugin, deferred.plugin, graph.plugin],
    });
    packing = false;
    workerFactory = packed.factory;
    published = packed;
    facades = packed.facades;
  } else if (deferred) {
    // Deferred entries evaluate nothing until launch(), so one shared module keeps their timing.
    const single = planSingleModule({
      mainEntry: "claude",
      entries,
      exports: entryExports(split.metafile, output, entries),
    });
    published = await Esbuild.build({
      ...shared,
      entryPoints: { [single.bundleName]: single.entryPoint },
      plugins: [single.plugin, deferred.plugin, graph.plugin],
    });
    facades = single.facades;
  }
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
  const publishedFiles = published.outputFiles.map((file) => ({
    path: NodePath.relative(output, file.path).split(NodePath.sep).join("/"),
    contents: file.contents,
  }));
  const modules = [
    ...inlineLegalNotices(publishedFiles),
    ...facades,
    ...Object.entries(options.runtimeModules ?? {}).map(([path, source]) => ({
      path,
      contents: new TextEncoder().encode(source),
    })),
  ];
  assertOneByteModules(modules);
  const workerEntries = options.partitionHooksWorker
    ? hooksWorkerEntries(workerInputs, input.byName, modules, workerFactory!, sourceByName)
    : undefined;
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
    ...(workerEntries ? { workerEntries } : {}),
    hostEntrypoints,
    modules,
    assets: embeddedAssets,
    requiredHostModules: [...requiredHostModules],
    sourceModules: [...loaded],
    ...(omission ? { omission: omission.manifest() } : {}),
    metafile: published.metafile,
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

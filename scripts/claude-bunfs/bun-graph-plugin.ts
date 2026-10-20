// @effect-diagnostics nodeBuiltinImport:off - build-time release transformation.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type * as Esbuild from "esbuild";
import type { readExtraction } from "./extracted-input.ts";
import { normalizeModule } from "./normalize.ts";
import type { RebundleOptions } from "./rebundle.ts";

export const NODE_BUILTINS = new Set(
  NodeModule.builtinModules.flatMap((name) => [name, `node:${name}`]),
);

/** Resolves and loads the extracted Bun graph. Loads are cached so every build transforms once. */
export function createBunGraphPlugin(input: {
  readonly extraction: Awaited<ReturnType<typeof readExtraction>>;
  readonly sources: ReadonlyMap<string, string>;
  readonly options: RebundleOptions;
  readonly deferSource: (source: string, importer: string) => string;
}) {
  const { extraction, options, deferSource } = input;
  const loaded = new Set<string>();
  const requiredHostModules = new Set<string>();
  const loads = new Map<string, Promise<Esbuild.OnLoadResult>>();
  const once = (args: Esbuild.OnLoadArgs, load: () => Promise<Esbuild.OnLoadResult>) => {
    const key = `${args.namespace}\0${args.path}`;
    let result = loads.get(key);
    if (!result) loads.set(key, (result = load()));
    return result;
  };
  const plugin: Esbuild.Plugin = {
    name: "bun-extracted-graph",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (options.layerModules && Object.hasOwn(options.layerModules, args.path))
          return { path: args.path, namespace: "signalbox-layer" };
        if (Object.hasOwn(options.environmentPackageModules ?? {}, args.path))
          return { path: args.path, namespace: "signalbox-environment-package" };
        if (NODE_BUILTINS.has(args.path)) {
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
        const module = extraction.byName.get(name) ?? extraction.byKey.get(name);
        if (!module)
          throw new Error(`BUN_IMPORT_UNRESOLVED: ${args.importer || "<entry>"}: ${args.path}`);
        return { path: module.name, namespace: "bun-graph" };
      });
      build.onLoad({ filter: /.*/, namespace: "signalbox-layer" }, (args) =>
        once(args, async () => ({
          contents: deferSource(options.layerModules![args.path]!, args.path),
          loader: "js",
        })),
      );
      build.onLoad({ filter: /.*/, namespace: "signalbox-environment-package" }, (args) =>
        once(args, async () => ({
          contents: deferSource(options.environmentPackageModules![args.path]!, args.path),
          loader: "js",
        })),
      );
      build.onLoad({ filter: /.*/, namespace: "bun-graph" }, (args) =>
        once(args, async () => {
          const module = extraction.byName.get(args.path)!;
          const key = module.key ?? module.name.replace(/^\/+/, "");
          loaded.add(key);
          if (module.loader === 1) {
            const normalized = normalizeModule({
              name: module.name,
              key,
              source: input.sources.get(module.name)!,
              format: module.format,
              isEntry: module.index === extraction.manifest.graph.entry,
            });
            const source = options.transform
              ? await options.transform(normalized)
              : normalized.source;
            return { contents: deferSource(source, module.name), loader: "js" };
          }
          if (module.loader === 13) {
            const bytes = await extraction.readContents(module);
            const text =
              module.encoding === 2 ? bytes.toString("utf16le") : bytes.toString("latin1");
            return { contents: text, loader: "text" };
          }
          if (module.loader === 5) {
            return { contents: `export default ${JSON.stringify(module.name)};`, loader: "js" };
          }
          throw new Error(`BUN_LOADER_REQUIRES_HOST: ${module.name}: loader ${module.loader}`);
        }),
      );
    },
  };
  return { plugin, loaded, requiredHostModules };
}

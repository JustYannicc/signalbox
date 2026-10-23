// @effect-diagnostics nodeBuiltinImport:off - offline linking of verified published sources.
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import type { BuiltinSource } from "./source.ts";
import { workerFactoryBuiltinSources } from "./workerFactory.ts";

/** Resolve cross-partition builtin bindings for analysis without executing release code. */
export async function linkPublishedSources(
  sources: readonly BuiltinSource[],
): Promise<BuiltinSource> {
  sources = workerFactoryBuiltinSources(sources);
  const files = new Map(sources.map((source) => [source.name, source.source]));
  const root = "signalbox:published-analysis";
  const built = await Esbuild.build({
    entryPoints: [root],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    minifyWhitespace: true,
    legalComments: "none",
    logLevel: "silent",
    plugins: [
      {
        name: "verified-release-sources",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === root && args.kind === "entry-point")
              return { path: root, namespace: "published" };
            const path =
              args.importer === root
                ? args.path
                : NodePath.posix.normalize(
                    NodePath.posix.join(NodePath.posix.dirname(args.importer), args.path),
                  );
            return files.has(path) ? { path, namespace: "published" } : undefined;
          });
          build.onLoad({ filter: /.*/, namespace: "published" }, (args) => {
            const contents =
              args.path === root
                ? sources
                    .map(
                      (source, index) =>
                        `export * as source${index} from ${JSON.stringify(source.name)};`,
                    )
                    .join("\n")
                : files.get(args.path);
            if (contents === undefined)
              throw new Error(`NODE_BUILTIN_PUBLISHED_LINK_MISSING: ${args.path}`);
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  const output = built.outputFiles[0];
  if (!output) throw new Error("NODE_BUILTIN_PUBLISHED_LINK_FAILED");
  return { name: root, source: output.text };
}

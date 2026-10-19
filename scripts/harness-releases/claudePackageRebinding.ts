import * as NodeModule from "node:module";
import * as Esbuild from "esbuild";

export async function rebindClaudePackageImports(
  specifier: string,
  source: string,
  expectedNativeImports: ReadonlyArray<string>,
  layerModules: Readonly<Record<string, string>>,
) {
  const expected = new Set(expectedNativeImports);
  const bound = new Set<string>();
  const namespace = "proof-bridge";
  const result = await Esbuild.build({
    stdin: {
      contents: source,
      loader: "js",
      resolveDir: process.cwd(),
      sourcefile: `${specifier}.raw.js`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    minifyWhitespace: true,
    legalComments: "inline",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "signalbox-claude-node-bridge",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const builtin = args.path.startsWith("node:") ? args.path.slice(5) : args.path;
            if (!Object.hasOwn(layerModules, builtin)) {
              if (NodeModule.isBuiltin(args.path))
                throw new Error(`CLAUDE_PACKAGE_BUILTIN_UNROUTED: ${specifier}: ${args.path}`);
              return undefined;
            }
            const canonical = `node:${builtin}`;
            if (!expected.has(canonical))
              throw new Error(
                `CLAUDE_PACKAGE_NATIVE_IMPORT_UNRECORDED: ${specifier}: ${args.path}`,
              );
            if (!Object.hasOwn(layerModules, builtin))
              throw new Error(`CLAUDE_PACKAGE_BUILTIN_UNROUTED: ${specifier}: ${builtin}`);
            bound.add(canonical);
            return { path: canonical, namespace };
          });
          build.onLoad({ filter: /.*/, namespace }, (args) => ({
            contents: layerModules[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const output = result.outputFiles?.[0]?.text;
  const metafile = result.metafile;
  if (!output || !metafile) throw new Error(`CLAUDE_PACKAGE_REBIND_OUTPUT_MISSING: ${specifier}`);
  const external = Object.values(metafile.outputs).flatMap((item) =>
    item.imports.filter((entry) => entry.external).map((entry) => entry.path),
  );
  if (external.length)
    throw new Error(
      `CLAUDE_PACKAGE_REBIND_EXTERNALS: ${specifier}: ${[...new Set(external)].sort().join(",")}`,
    );
  const sortedExpected = [...expected].sort((a, b) => a.localeCompare(b));
  const sortedBound = [...bound].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(sortedBound) !== JSON.stringify(sortedExpected))
    throw new Error(`CLAUDE_PACKAGE_REBIND_COVERAGE_MISMATCH: ${specifier}`);
  return { source: output, nativeImports: sortedBound };
}

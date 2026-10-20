// @effect-diagnostics nodeBuiltinImport:off - build-time release transformation.
import * as NodePath from "node:path";
import type * as Esbuild from "esbuild";
import type { BundleFile } from "./bundle-artifact.ts";

const MAIN_SPECIFIER = "signalbox:release-main";
const MAIN_NAMESPACE = "signalbox-release-main";

/** Export names of each entry output, read from a split build of the same entries. */
export function entryExports(
  metafile: Esbuild.Metafile,
  output: string,
  entries: Readonly<Record<string, string>>,
): Record<string, readonly string[]> {
  const byPath = new Map(
    Object.entries(metafile.outputs).map(([path, value]) => [NodePath.resolve(path), value]),
  );
  const exports: Record<string, readonly string[]> = {};
  for (const name of Object.keys(entries)) {
    const built = byPath.get(NodePath.join(output, `${name}.js`));
    if (!built) throw new Error(`BUNDLE_ENTRY_OUTPUT_MISSING: ${name}`);
    exports[name] = built.exports;
  }
  return exports;
}

// String export names (ES2022) accept reserved words and never collide with facade locals.
const names = (exported: readonly string[]) => exported.map((name) => JSON.stringify(name));

/**
 * One module per release keeps the isolate inside its memory limit: thousands of split chunks
 * cost tens of MiB of module records. Every entry keeps its path as a facade over that module,
 * so entries share its instances. Secondary entries evaluate when their facade is imported and
 * export snapshots, which holds for deferred entries: they export launch() or functions only.
 */
export function planSingleModule(input: {
  readonly mainEntry: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, readonly string[]>>;
}) {
  const exportsOf = (entry: string) => {
    const exported = input.exports[entry];
    if (!exported) throw new Error(`BUNDLE_ENTRY_EXPORTS_MISSING: ${entry}`);
    return exported;
  };
  const mainSpecifier = input.entries[input.mainEntry];
  if (mainSpecifier === undefined) throw new Error(`BUNDLE_ENTRY_MISSING: ${input.mainEntry}`);
  let bundleName = "signalbox/release";
  while (Object.hasOwn(input.entries, bundleName)) bundleName = `${bundleName}_`;
  const mainNames = names(exportsOf(input.mainEntry));
  const lines = [`export {${mainNames.join(",")}} from ${JSON.stringify(mainSpecifier)};`];
  const bundleImport = (entry: string) => {
    const relative = NodePath.posix.relative(NodePath.posix.dirname(entry), `${bundleName}.js`);
    return JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`);
  };
  const encoder = new TextEncoder();
  const facades: BundleFile[] = [
    {
      path: `${input.mainEntry}.js`,
      contents: encoder.encode(
        `export {${mainNames.join(",")}} from ${bundleImport(input.mainEntry)};\n`,
      ),
    },
  ];
  const secondaries = Object.entries(input.entries).filter(([name]) => name !== input.mainEntry);
  for (const [index, [name, specifier]] of secondaries.entries()) {
    const accessor = JSON.stringify(`signalbox:entry:${index}`);
    // A bundled require() evaluates the entry on first call. CJS returns module.exports itself.
    lines.push(
      `function load${index}(){const m=require(${JSON.stringify(specifier)});return m&&m.__esModule?m:{default:m}}`,
      `export {load${index} as ${accessor}};`,
    );
    const exported = exportsOf(name);
    const source = [
      `import {${accessor} as load} from ${bundleImport(name)};`,
      "const entry=load();",
      ...exported.map((member, position) => `const v${position}=entry[${JSON.stringify(member)}];`),
      `export {${exported.map((member, position) => `v${position} as ${JSON.stringify(member)}`).join(",")}};`,
      "",
    ].join("\n");
    facades.push({ path: `${name}.js`, contents: encoder.encode(source) });
  }
  const plugin: Esbuild.Plugin = {
    name: "signalbox-release-main",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${MAIN_SPECIFIER}$`) }, (args) => ({
        path: args.path,
        namespace: MAIN_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: MAIN_NAMESPACE }, () => ({
        contents: lines.join("\n"),
        loader: "js",
      }));
    },
  };
  return { bundleName, entryPoint: MAIN_SPECIFIER, plugin, facades };
}

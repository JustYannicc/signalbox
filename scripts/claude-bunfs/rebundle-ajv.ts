// @effect-diagnostics nodeBuiltinImport:off - build-time code generation.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import {
  precompileAjvMetaValidators,
  precompileAjvModule,
  replaceEmbeddedAjvConstructors,
  type AjvDiagnostic,
} from "./ajv-precompile.ts";

const require = NodeModule.createRequire(import.meta.url);
const prefix = "signalbox:ajv/";
const adapter = `${prefix}adapter`;
const runtime = `${prefix}registry-runtime`;

/** Resolve compiler-only helper imports while producing portable, compiler-free modules. */
async function portable(
  source: string,
  virtual: Readonly<Record<string, string>> = {},
  loader: "js" | "ts" = "js",
) {
  const result = await Esbuild.build({
    stdin: {
      contents: source,
      loader,
      sourcefile: `ajv-adapter.${loader}`,
      resolveDir: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    metafile: true,
    plugins: [
      {
        name: "ajv-generated-validators",
        setup(build) {
          build.onResolve({ filter: /^signalbox:ajv\// }, (args) =>
            args.path === runtime
              ? { path: runtime, external: true }
              : Object.hasOwn(virtual, args.path)
                ? { path: args.path, namespace: "ajv-generated" }
                : undefined,
          );
          // The adapter and host must share one sticky compatibility failure state.
          build.onResolve({ filter: /ajv-precompile-runtime\.ts$/ }, () => ({
            path: runtime,
            external: true,
          }));
          build.onResolve({ filter: /^ajv\/dist\/runtime\// }, (args) => ({
            path: require.resolve(args.path),
          }));
          build.onLoad({ filter: /.*/, namespace: "ajv-generated" }, (args) => ({
            contents: virtual[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /(?:^|[\\/])ajv-precompile-runtime\.(?:ts|js)$/.test(path),
    )
  )
    throw new Error("AJV_COMPATIBILITY_STATE_DUPLICATED");
  return result.outputFiles[0]!.text;
}

export async function createAjvRebundleTransform() {
  const metas = precompileAjvMetaValidators();
  const virtual: Record<string, string> = {};
  for (const [dialect, validator] of Object.entries(metas))
    virtual[`${prefix}meta/${dialect}`] = validator.source;
  const interpreterPath = NodeURL.fileURLToPath(
    new URL("./ajv-precompile-interpreter.ts", import.meta.url),
  );
  const runtimePath = NodeURL.fileURLToPath(
    new URL("./ajv-precompile-runtime.ts", import.meta.url),
  );
  const compatibility = `${prefix}compatibility`;
  const layerModules: Record<string, string> = {
    [compatibility]: `export {assertAjvCompatibility, resetAjvCompatibility} from ${JSON.stringify(runtime)};`,
    [adapter]: await portable(
      `import {createInterpretedAjv} from ${JSON.stringify(interpreterPath)};
      import draft7 from '${prefix}meta/draft7';
      import meta2019 from '${prefix}meta/2019';
      import meta2020 from '${prefix}meta/2020';
      export const createAjv=(dialect)=>createInterpretedAjv({draft7,'2019':meta2019,'2020':meta2020},dialect);
      export {resetAjvCompatibility,assertAjvCompatibility} from '${runtime}';`,
      virtual,
    ),
    [runtime]: await portable(
      await import("node:fs/promises").then((fs) => fs.readFile(runtimePath, "utf8")),
      {},
      "ts",
    ),
  };
  const diagnostics: AjvDiagnostic[] = [];
  const constructors: ReturnType<typeof replaceEmbeddedAjvConstructors>["constructors"] = [];
  const guardedSources = new Set<string>();
  const sites: {
    module: string;
    staticSites: number;
    interpretedSites: number;
    uniqueValidators: number;
  }[] = [];
  const transform = async (input: {
    key: string;
    name: string;
    source: string;
    format: number;
  }) => {
    const id = NodeCrypto.createHash("sha256").update(input.key).digest("hex").slice(0, 24);
    const registry = `${prefix}registry/${id}`;
    const compiled = precompileAjvModule(
      { ...input, format: input.format === 2 ? 2 : 1 },
      {
        registrySpecifier: registry,
        runtimeSpecifier: runtime,
        validatorSpecifier: (validator) => `${prefix}validator/${validator}`,
        allowUnresolved: true,
        preserveUnresolvedCalls: true,
      },
    );
    diagnostics.push(...compiled.diagnostics);
    if (compiled.registrySource) layerModules[registry] = compiled.registrySource;
    for (const validator of compiled.validators)
      layerModules[`${prefix}validator/${validator.id}`] = await portable(validator.source);
    const replaced = replaceEmbeddedAjvConstructors(
      { ...input, source: compiled.source, format: input.format === 2 ? 2 : 1 },
      adapter,
    );
    constructors.push(...replaced.constructors);
    if (compiled.analysis.calls.length || replaced.constructors.length)
      guardedSources.add(`bun-graph:${input.name}`);
    if (compiled.analysis.calls.length)
      sites.push({
        module: input.key,
        staticSites: compiled.compiledSiteCount,
        interpretedSites: compiled.analysis.calls.length - compiled.compiledSiteCount,
        uniqueValidators: compiled.validators.length,
      });
    return replaced.source;
  };
  const verify = (
    metafile: Esbuild.Metafile,
    embeddedEntrypoints: Readonly<Record<string, string>>,
  ) => {
    for (const target of Object.keys(embeddedEntrypoints)) {
      const entryPath = embeddedEntrypoints[target]!;
      const entry = Object.entries(metafile.outputs).find(
        ([path]) => path === entryPath || path.endsWith(`/${entryPath}`),
      );
      if (!entry) throw new Error(`AJV_WORKER_GRAPH_UNRESOLVED: ${target}`);
      const visited = new Set<string>();
      const pending = [entry[0]];
      while (pending.length) {
        const path = pending.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const output = metafile.outputs[path];
        if (!output) throw new Error(`AJV_WORKER_GRAPH_UNRESOLVED: ${path}`);
        for (const [source, input] of Object.entries(output.inputs))
          if (input.bytesInOutput > 0 && guardedSources.has(source))
            throw new Error(`AJV_WORKER_COMPATIBILITY_UNOBSERVED: ${target}: ${source}`);
        for (const dependency of output.imports) {
          if (dependency.external) continue;
          const dependencyPath = Object.hasOwn(metafile.outputs, dependency.path)
            ? dependency.path
            : NodePath.posix.normalize(
                NodePath.posix.join(NodePath.posix.dirname(path), dependency.path),
              );
          pending.push(dependencyPath);
        }
      }
    }
  };
  // Pass this same layerModules object: transform adds validators while the graph is loading.
  return {
    layerModules,
    hostEntrypoints: { "signalbox/ajv-compatibility": compatibility },
    transform,
    verify,
    report: () => ({
      constructors: [...constructors],
      sites: [...sites],
      diagnostics: [...diagnostics],
    }),
  };
}

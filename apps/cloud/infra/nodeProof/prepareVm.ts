// @effect-diagnostics nodeBuiltinImport:off - build-time preparation for the shared workerd proof.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { parse, version as acornVersion } from "acorn";
import * as Esbuild from "esbuild";
import {
  primordialAcorn,
  NODE_VM_EXPRESSION_ANALYSIS_SOURCE,
  NODE_VM_FUNCTION_RUNTIME_SOURCE,
  NODE_VM_FUNCTION_PARSER_SOURCE,
  nimbusFunctionBuildSource,
} from "../../src/isolate/NodeVmBuild.ts";

const CORE_SRC = NodeURL.fileURLToPath(
  new URL("../../src/isolate/node/vm/vendor/nimbus/core/src/", import.meta.url),
);

export const NODE_VM_PREPARED_MODULES = Object.freeze({
  primordials: "node/vm/interpreter-primordials.js",
  parser: "node/vm/parser.js",
  interpreter: "node/vm/interpreter.js",
  hostOps: "node/vm/host-ops.js",
  moduleHelpers: "node/vm/module-helpers.js",
  expressionAnalysis: "node/vm/expression-analysis.js",
  functionRuntime: "node/vm/function-runtime.js",
});

// Canonical runtime builder, shared by tests and the workerd proof.
export async function prepareNodeVmModules(
  destination: string,
): Promise<Readonly<Record<string, string>>> {
  const modules = await bundleNodeVmModules();
  for (const [name, source] of Object.entries(modules)) {
    const path = NodePath.join(destination, name);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, source);
  }
  return modules;
}

async function bundleNodeVmModules(): Promise<Readonly<Record<string, string>>> {
  if (acornVersion !== "8.16.0") {
    throw new Error(`Node vm interpreter requires acorn 8.16.0; found ${acornVersion}`);
  }
  if (Esbuild.version !== "0.28.2") {
    throw new Error(`Node vm interpreter requires esbuild 0.28.2; found ${Esbuild.version}`);
  }

  const common = {
    bundle: true,
    platform: "neutral" as const,
    target: "esnext",
    mainFields: ["module", "main"],
    minify: true,
    legalComments: "none" as const,
    write: false,
    metafile: true,
  };
  const primordialModulePath = "./interpreter-primordials.js";
  const externalizePrimordials = (build: Esbuild.PluginBuild) => {
    build.onResolve({ filter: /^\.\/primordials\.js$/ }, () => ({
      path: primordialModulePath,
      external: true,
    }));
  };
  const parserPlugin = (name: string): Esbuild.Plugin => ({
    name,
    setup(build) {
      externalizePrimordials(build);
      build.onResolve({ filter: /^acorn$/ }, () => ({ path: "./parser.js", external: true }));
    },
  });

  const primordials = await Esbuild.build({
    ...common,
    entryPoints: [NodePath.join(CORE_SRC, "interpreter/primordials.ts")],
    format: "cjs",
  });

  let rewrittenAcorn: string | null = null;
  const parserBuild = await Esbuild.build({
    ...common,
    entryPoints: [NodePath.join(CORE_SRC, "interpreter/parser.ts")],
    format: "esm",
    plugins: [
      {
        name: "nimbus-parser-primordials",
        setup(build) {
          externalizePrimordials(build);
          build.onLoad({ filter: /[\\/]acorn[\\/]dist[\\/]acorn\.mjs$/ }, async (args) => {
            if (rewrittenAcorn !== null) {
              throw new Error(`[node-vm] acorn loaded twice (${args.path})`);
            }
            rewrittenAcorn = primordialAcorn(
              await NodeFSP.readFile(args.path, "utf8"),
              NodePath.join(CORE_SRC, "interpreter/parser-realm.ts"),
            ).code;
            return { contents: rewrittenAcorn, loader: "js" };
          });
        },
      },
    ],
  });
  const parserMetafile = parserBuild.metafile;
  if (!parserMetafile) {
    throw new Error("[node-vm] parser bundle did not return a metafile");
  }
  const parserAcornInputs = Object.keys(parserMetafile.inputs).filter((path) =>
    /(^|[\\/])acorn[\\/]/.test(path),
  );
  if (rewrittenAcorn === null || parserAcornInputs.length !== 1) {
    throw new Error(
      `[node-vm] expected one rewritten acorn input; found ${parserAcornInputs.join(", ") || "none"}`,
    );
  }

  const interpreterBuild = await Esbuild.build({
    ...common,
    entryPoints: [NodePath.join(CORE_SRC, "interpreter/index.ts")],
    format: "esm",
    plugins: [parserPlugin("nimbus-parser-module")],
  });
  const analysisBuild = await Esbuild.build({
    ...common,
    entryPoints: [NodeURL.fileURLToPath(NODE_VM_EXPRESSION_ANALYSIS_SOURCE)],
    format: "esm",
    plugins: [parserPlugin("nimbus-expression-analysis-parser")],
  });
  const functionRuntimeBuild = await Esbuild.build({
    ...common,
    stdin: {
      contents: `export { runtimeFunctionModule } from ${JSON.stringify(NodeURL.fileURLToPath(NODE_VM_FUNCTION_RUNTIME_SOURCE))};`,
      resolveDir: CORE_SRC,
    },
    format: "esm",
    plugins: [
      {
        name: "nimbus-function-runtime-closure",
        setup(build) {
          externalizePrimordials(build);
          build.onResolve({ filter: /^acorn$/ }, () => ({
            path: NodeURL.fileURLToPath(NODE_VM_FUNCTION_PARSER_SOURCE),
          }));
          build.onResolve({ filter: /^\.\/(parser|interpreter-primordials)\.js$/ }, ({ path }) => ({
            path,
            external: true,
          }));
          build.onLoad({ filter: /[\\/](commonjs-cell|javascript-ast)\.ts$/ }, async ({ path }) => {
            const stripped = await Esbuild.transform(await NodeFSP.readFile(path, "utf8"), {
              loader: "ts",
              target: "esnext",
            });
            return {
              contents: nimbusFunctionBuildSource(
                stripped.code,
                path.endsWith("commonjs-cell.ts") ? "commonjs-cell" : "javascript-ast",
              ),
              loader: "js",
              resolveDir: NodePath.dirname(path),
            };
          });
        },
      },
    ],
  });
  const interpreterMetafile = interpreterBuild.metafile;
  if (!interpreterMetafile) {
    throw new Error("[node-vm] interpreter bundle did not return a metafile");
  }
  const bundledAcornInputs = Object.keys(interpreterMetafile.inputs).filter((path) =>
    /(^|[\\/])acorn[\\/]/.test(path),
  );
  if (bundledAcornInputs.length !== 0) {
    throw new Error(`[node-vm] interpreter bundled acorn: ${bundledAcornInputs.join(", ")}`);
  }

  const hostOpsBuild = await Esbuild.build({
    entryPoints: [NodePath.join(CORE_SRC, "interpreter/host-ops.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  const hostOpsSource = await importBundleExport(
    hostOpsBuild.outputFiles?.[0]?.text,
    "HOST_OPS_SOURCE",
    "host operations",
  );
  if (typeof hostOpsSource !== "string" || hostOpsSource.length === 0) {
    throw new Error("[node-vm] Nimbus host-ops.ts did not provide HOST_OPS_SOURCE");
  }
  if (/^\s*["']use strict["']/.test(hostOpsSource)) {
    throw new Error("[node-vm] HOST_OPS_SOURCE must remain a sloppy CommonJS module");
  }

  const helpersBuild = await Esbuild.build({
    stdin: {
      contents: `export { ESM_MODULE_HELPERS } from ${JSON.stringify(NodePath.join(CORE_SRC, "runtime/esm-interop.ts"))};`,
      resolveDir: CORE_SRC,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const moduleHelpersSource = await importBundleExport(
    helpersBuild.outputFiles?.[0]?.text,
    "ESM_MODULE_HELPERS",
    "module helpers",
  );
  if (typeof moduleHelpersSource !== "string" || moduleHelpersSource.length === 0) {
    throw new Error("[node-vm] esm-interop.ts did not provide ESM_MODULE_HELPERS");
  }

  const parser = asCommonJs(parserBuild.outputFiles?.[0]?.text, "parser");
  const interpreter = asCommonJs(interpreterBuild.outputFiles?.[0]?.text, "interpreter");
  const analysis = asCommonJs(analysisBuild.outputFiles?.[0]?.text, "expression analysis");
  const functionRuntime = asCommonJs(
    functionRuntimeBuild.outputFiles?.[0]?.text,
    "function runtime",
  );
  const missingParserExports = [
    ...interpreter.imports,
    ...analysis.imports,
    ...functionRuntime.imports,
  ].filter((name) => !parser.exports.includes(name));
  if (missingParserExports.length > 0) {
    throw new Error(`[node-vm] parser is missing exports: ${missingParserExports.join(", ")}`);
  }

  return Object.freeze({
    [NODE_VM_PREPARED_MODULES.primordials]: requiredOutput(
      primordials.outputFiles?.[0]?.text,
      "primordials",
    ),
    [NODE_VM_PREPARED_MODULES.parser]: parser.text,
    [NODE_VM_PREPARED_MODULES.interpreter]: interpreter.text,
    [NODE_VM_PREPARED_MODULES.hostOps]: hostOpsSource,
    [NODE_VM_PREPARED_MODULES.moduleHelpers]: `module.exports = ${moduleHelpersSource};`,
    [NODE_VM_PREPARED_MODULES.expressionAnalysis]: analysis.text,
    [NODE_VM_PREPARED_MODULES.functionRuntime]: functionRuntime.text,
  });
}

async function importBundleExport(
  source: string | undefined,
  exportName: string,
  label: string,
): Promise<unknown> {
  if (!source) throw new Error(`[node-vm] ${label} bundle was empty`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = (await import(moduleUrl)) as Record<string, unknown>;
  return module[exportName];
}

function requiredOutput(source: string | undefined, label: string): string {
  if (!source) throw new Error(`[node-vm] ${label} module bundle was empty`);
  return source;
}

function asCommonJs(
  source: string | undefined,
  label: "parser" | "interpreter" | "expression analysis" | "function runtime",
) {
  if (!source) throw new Error(`[node-vm] ${label} bundle was empty`);
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const edits: { start: number; end: number; text: string }[] = [];
  const imports: string[] = [];
  const exports: string[] = [];

  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      const [only] = node.specifiers;
      const request = JSON.stringify(node.source.value);
      if (
        node.source.value === "./interpreter-primordials.js" &&
        node.specifiers.length === 1 &&
        only?.type === "ImportNamespaceSpecifier"
      ) {
        edits.push({
          start: node.start,
          end: node.end,
          text: `const ${only.local.name} = require(${request});`,
        });
      } else if (label !== "parser" && node.source.value === "./parser.js") {
        const fields: string[] = [];
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
            throw new Error(`[node-vm] ${label} imports parser through ${specifier.type}`);
          }
          fields.push(`${specifier.imported.name}: ${specifier.local.name}`);
          imports.push(specifier.imported.name);
        }
        edits.push({
          start: node.start,
          end: node.end,
          text: `const { ${fields.join(", ")} } = require(${request});`,
        });
      } else {
        throw new Error(`[node-vm] ${label} imports unexpected module ${node.source.value}`);
      }
    } else if (node.type === "ExportNamedDeclaration" && !node.declaration && !node.source) {
      const exportName = (specifier: (typeof node.specifiers)[number]) =>
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      const fields = node.specifiers.map((specifier) => {
        if (specifier.local.type !== "Identifier") {
          throw new Error(`[node-vm] ${label} exports a non-identifier local`);
        }
        return `${JSON.stringify(exportName(specifier))}: ${specifier.local.name}`;
      });
      exports.push(...node.specifiers.map(exportName));
      edits.push({
        start: node.start,
        end: node.end,
        text: `module.exports = { ${fields.join(", ")} };`,
      });
    } else if (node.type.startsWith("Export")) {
      throw new Error(`[node-vm] ${label} bundle has unexpected ${node.type}`);
    }
  }

  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text: `"use strict";\n${text}`, imports, exports };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a prepared module output directory");
  await prepareNodeVmModules(NodePath.resolve(destination));
}

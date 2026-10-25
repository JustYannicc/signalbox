// @effect-diagnostics nodeBuiltinImport:off - build-time graph packing.
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import ts from "typescript-legacy";
import type { BundleFile, WorkerReleaseEntry } from "./bundle-artifact.ts";
import type { ExtractedModule } from "./extracted-input.ts";
import type { planSingleModule } from "./single-module.ts";
import { applySourceEdits } from "./source-edits.ts";
import { createWorkerFactory } from "./worker-factory.ts";
import { analyzeWorkerFactory } from "./worker-factory-analysis.ts";

export const HOOKS_WORKER_ENTRY =
  "/$bunfs/root/src/plugins/functionHooks/hooks-worker/hooks-worker.js";
export const HOOKS_WORKER_MODULE = "signalbox/worker-hooks.js";
const ROOT_MODULE = "signalbox/worker-hooks-entry.js";

/** Includes static and dynamic imports before corpus stubs can remove edges. */
export function workerInputClosure(metafile: Esbuild.Metafile, entry: string) {
  const root = `bun-graph:${entry}`;
  if (!Object.hasOwn(metafile.inputs, root))
    throw new Error(`BUNDLE_WORKER_ENTRY_MISSING: ${entry}`);
  const inputs = new Set<string>();
  const visit = (path: string) => {
    if (inputs.has(path)) return;
    const module = metafile.inputs[path];
    if (!module) throw new Error(`BUNDLE_WORKER_INPUT_MISSING: ${path}`);
    inputs.add(path);
    for (const dependency of module.imports) if (!dependency.external) visit(dependency.path);
  };
  visit(root);
  return inputs;
}

const parse = (name: string, source: string) =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const replace = applySourceEdits;
const wrongShape = () => new Error("BUNDLE_WORKER_PACK_SHAPE_CHANGED");

/** Pack original inputs once. The main entry reaches every secondary, so the worker's entire
 * closure becomes one shared chunk. Only its generated entry facade needs folding into it. */
export async function packWorkerPartition(input: {
  readonly output: string;
  readonly main: ReturnType<typeof planSingleModule>;
  readonly workerSpecifier: string;
  readonly workerEntry: string;
  readonly workerInputs: ReadonlySet<string>;
  readonly shared: Esbuild.BuildOptions;
  readonly plugins: Esbuild.Plugin[];
}) {
  const built = await Esbuild.build({
    ...input.shared,
    entryPoints: {
      [input.main.bundleName]: input.main.entryPoint,
      [ROOT_MODULE.slice(0, -3)]: input.workerSpecifier,
    },
    splitting: true,
    chunkNames: "signalbox/worker-hooks",
    plugins: input.plugins,
  });
  if (!built.outputFiles || !built.metafile) throw wrongShape();
  const paths = {
    main: NodePath.join(input.output, `${input.main.bundleName}.js`),
    worker: NodePath.join(input.output, HOOKS_WORKER_MODULE),
    root: NodePath.join(input.output, ROOT_MODULE),
  };
  const files = new Map(built.outputFiles.map((file) => [file.path, file]));
  const outputs = new Map(
    Object.entries(built.metafile.outputs)
      .filter(([path]) => path.endsWith(".js"))
      .map(([path, entry]) => [NodePath.resolve(path), entry]),
  );
  if (outputs.size !== 3 || Object.values(paths).some((path) => !outputs.has(path)))
    throw wrongShape();
  const mainOutput = outputs.get(paths.main)!,
    workerOutput = outputs.get(paths.worker)!,
    rootOutput = outputs.get(paths.root)!;
  if (
    Object.values(rootOutput.inputs).some((input) => input.bytesInOutput !== 0) ||
    workerOutput.imports.some((dependency) => !dependency.external)
  )
    throw wrongShape();
  const owners = new Map<string, "worker" | "main">();
  for (const [path, output] of outputs) {
    const owner = path === paths.main ? "main" : "worker";
    for (const name of Object.keys(output.inputs)) {
      if (owners.has(name) && owners.get(name) !== owner)
        throw new Error(`BUNDLE_PARTITION_INPUT_DUPLICATE: ${name}`);
      if (owner === "worker" && name.startsWith("bun-graph:") && !input.workerInputs.has(name))
        throw new Error(`BUNDLE_WORKER_INPUT_OUTSIDE_CLOSURE: ${name}`);
      owners.set(name, owner);
    }
  }
  for (const name of Object.keys(built.metafile.inputs))
    if (!owners.has(name)) owners.set(name, input.workerInputs.has(name) ? "worker" : "main");
  const sharedSource = files.get(paths.worker)!.text;
  const sharedFile = parse(paths.worker, sharedSource);
  const bindings = new Map<string, string>();
  const sharedEdits: { start: number; end: number; text: string }[] = [];
  for (const statement of sharedFile.statements)
    if (ts.isExportDeclaration(statement)) {
      if (
        statement.moduleSpecifier ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        throw wrongShape();
      for (const item of statement.exportClause.elements)
        bindings.set(item.name.text, (item.propertyName ?? item.name).text);
      sharedEdits.push({ start: statement.getStart(sharedFile), end: statement.end, text: "" });
    }
  const rootSource = files.get(paths.root)!.text;
  const banner = input.shared.banner?.js;
  if (banner && !rootSource.startsWith(`${banner}\n`)) throw wrongShape();
  const rootFile = parse(paths.root, banner ? rootSource.slice(banner.length + 1) : rootSource);
  const imports = new Map<string, string>();
  let launch: string | undefined;
  const initializers: string[] = [];
  for (const statement of rootFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (
        NodePath.resolve(NodePath.dirname(paths.root), statement.moduleSpecifier.text) !==
        paths.worker
      )
        throw wrongShape();
      const clause = statement.importClause;
      if (
        !clause ||
        clause.name ||
        !clause.namedBindings ||
        !ts.isNamedImports(clause.namedBindings)
      )
        throw wrongShape();
      for (const item of clause.namedBindings.elements) {
        const value = bindings.get((item.propertyName ?? item.name).text);
        if (!value) throw wrongShape();
        imports.set(item.name.text, value);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const item of statement.exportClause.elements) {
        if (item.name.text !== "launch") throw wrongShape();
        launch = imports.get((item.propertyName ?? item.name).text);
      }
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.arguments.length === 0
    ) {
      const initialize = imports.get(statement.expression.expression.text);
      if (!initialize) throw wrongShape();
      initializers.push(`${initialize}();`);
    } else throw wrongShape();
  }
  if (!launch) throw wrongShape();
  const factory = createWorkerFactory({
    workerSource: replace(sharedSource, sharedEdits),
    mainSource: files.get(paths.main)!.text,
    ...(banner ? { banner } : {}),
    workerImport: "./worker-hooks.js",
    exports: bindings,
    initializers,
    launch,
  });
  const encoder = new TextEncoder();
  const mainBytes = encoder.encode(factory.mainSource),
    workerBytes = encoder.encode(factory.workerSource);
  const outputFiles = [
    { path: paths.main, contents: mainBytes },
    { path: paths.worker, contents: workerBytes },
  ];
  for (const [target, originals] of [
    [paths.main, [paths.main]],
    [paths.worker, [paths.worker, paths.root]],
  ] as const) {
    const notices = originals
      .flatMap((path) => files.get(`${path}.LEGAL.txt`)?.text ?? [])
      .join("\n");
    if (notices)
      outputFiles.push({ path: `${target}.LEGAL.txt`, contents: encoder.encode(notices) });
  }
  const outputKey = (path: string) =>
    Object.keys(built.metafile!.outputs).find((name) => NodePath.resolve(name) === path)!;
  return {
    outputFiles,
    facades: input.main.facades,
    factory: {
      globals: factory.globals,
      imports: factory.imports,
      computedGlobalAccess: factory.computedGlobalAccess,
      functionConstructors: factory.functionConstructors,
    },
    metafile: {
      inputs: built.metafile.inputs,
      partitions: {
        [HOOKS_WORKER_MODULE]: [...owners]
          .filter(([, owner]) => owner === "worker")
          .map(([name]) => name)
          .sort(),
        [`${input.main.bundleName}.js`]: [...owners]
          .filter(([, owner]) => owner === "main")
          .map(([name]) => name)
          .sort(),
      },
      outputs: {
        [outputKey(paths.main)]: { ...mainOutput, bytes: mainBytes.length },
        [outputKey(paths.worker)]: {
          ...workerOutput,
          inputs: { ...workerOutput.inputs, ...rootOutput.inputs },
          exports: ["instantiate"],
          bytes: workerBytes.length,
        },
      },
    },
  };
}

export function hooksWorkerEntries(
  closure: ReadonlySet<string>,
  sources: ReadonlyMap<string, ExtractedModule>,
  modules: readonly BundleFile[],
  factory: Pick<
    WorkerReleaseEntry,
    "globals" | "imports" | "computedGlobalAccess" | "functionConstructors"
  >,
  sourceByName: ReadonlyMap<string, string>,
): Readonly<Record<string, WorkerReleaseEntry>> {
  const inputs = [...closure].filter((name) => name.startsWith("bun-graph:")).sort();
  const sourceReports = inputs.map((name) => {
    const path = name.slice("bun-graph:".length);
    return analyzeWorkerFactory(sourceByName.get(path)!, path);
  });
  const combine = (key: "computedGlobalAccess" | "functionConstructors") => {
    const sites = sourceReports.flatMap((report) => report[key].sites);
    return { count: sites.length, sites };
  };
  return {
    "hooks-worker": {
      entry: `file://${HOOKS_WORKER_ENTRY}`,
      module: HOOKS_WORKER_MODULE,
      export: "instantiate",
      ...factory,
      sourceAnalysis: {
        computedGlobalAccess: combine("computedGlobalAccess"),
        functionConstructors: combine("functionConstructors"),
      },
      inputs,
      sourceBytes: inputs.reduce(
        (sum, name) =>
          sum + sources.get(name.slice("bun-graph:".length))!.artifacts.contents!.bytes,
        0,
      ),
      preparedBytes: modules.find((file) => file.path === HOOKS_WORKER_MODULE)!.contents.byteLength,
    },
  };
}

import { applySourceEdits } from "./source-edits.ts";
import ts from "typescript-legacy";
import { analyzeWorkerFactory, rewriteLexicalReferences } from "./worker-factory-analysis.ts";
import { ScopedBindings } from "./release-inventory-scope.ts";
import { bundledFacadeCandidate } from "../harness-releases/nodeBuiltinGate/bundledFacadeShape.ts";

const shape = () => new Error("BUNDLE_WORKER_FACTORY_SHAPE_CHANGED");
const parse = (source: string) =>
  ts.createSourceFile("worker.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const replace = applySourceEdits;
const unique = (source: string, name: string) => {
  while (source.includes(name)) name += "_";
  return name;
};

/** Only generated builtin facade bodies change; official module bodies stay in their slices. */
function bindBuiltinFacades(source: string, bindings: string) {
  const file = parse(source);
  const imports = new Set<string>();
  const scopes = new ScopedBindings(file);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      const facade = bundledFacadeCandidate(node.parent, scopes);
      if (facade) {
        if (!facade.verified) throw shape();
        const name = facade.specifier;
        const module = node.parameters[1]?.name;
        if (!module || !ts.isIdentifier(module) || !node.body || node.parameters.length !== 2)
          throw shape();
        imports.add(name);
        edits.push({
          start: node.body.getStart(file),
          end: node.body.end,
          text: `{${module.text}.exports=${bindings}.imports[${JSON.stringify(name)}].default;}`,
        });
        return;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "for" &&
      node.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === "signalbox.nodeBridge.v1",
      )
    )
      throw new Error("BUNDLE_WORKER_NODE_BRIDGE_UNBOUND");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { source: replace(source, edits), imports: [...imports].sort() };
}

export function createWorkerFactory(input: {
  readonly workerSource: string;
  readonly mainSource: string;
  readonly banner?: string;
  readonly workerImport: string;
  readonly exports: ReadonlyMap<string, string>;
  readonly initializers: readonly string[];
  readonly launch: string;
}) {
  const bindings = unique(input.workerSource, "__signalboxBindings");
  const instance = unique(input.mainSource, "__signalboxWorker");
  const instantiate = unique(input.mainSource, "__signalboxInstantiate");
  const parentGlobals = unique(input.mainSource, "__signalboxParentGlobals");
  let body = input.workerSource;
  if (input.banner) {
    if (!body.startsWith(`${input.banner}\n`)) throw shape();
    body = body.slice(input.banner.length + 1);
  }
  const rawAnalysis = analyzeWorkerFactory(body, "signalbox/worker-hooks.js");
  if (rawAnalysis.globals.includes("arguments"))
    throw new Error("BUNDLE_WORKER_TOP_LEVEL_ARGUMENTS");
  const file = parse(body);
  const lexicalShape = (node: ts.Node): void => {
    if (
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      throw new Error("BUNDLE_WORKER_UNBOUND_MODULE_SYNTAX");
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      let owner = node.parent;
      while (
        owner &&
        !(ts.isFunctionLike(owner) && !ts.isArrowFunction(owner)) &&
        !ts.isClassLike(owner)
      )
        owner = owner.parent;
      if (!owner) throw new Error("BUNDLE_WORKER_TOP_LEVEL_THIS");
    }
    ts.forEachChild(node, lexicalShape);
  };
  lexicalShape(file);
  const imports = new Set<string>();
  const importReferences = new Map<string, string>();
  const importInitializers: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) throw shape();
    const specifier = statement.moduleSpecifier.text;
    imports.add(specifier);
    const namespace = unique(body, `__signalboxImport${importInitializers.length}`);
    importInitializers.push(
      `const ${namespace}=${bindings}.imports[${JSON.stringify(specifier)}];`,
    );
    const clause = statement.importClause;
    if (clause?.name) importReferences.set(clause.name.text, `(${namespace}.default)`);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings))
        importReferences.set(clause.namedBindings.name.text, namespace);
      else
        for (const item of clause.namedBindings.elements)
          importReferences.set(
            item.name.text,
            `(${namespace}[${JSON.stringify((item.propertyName ?? item.name).text)}])`,
          );
    }
  }
  body = rewriteLexicalReferences(body, importReferences);
  const rewrittenImports = parse(body);
  body =
    importInitializers.join("\n") +
    "\n" +
    replace(
      body,
      rewrittenImports.statements.filter(ts.isImportDeclaration).map((statement) => ({
        start: statement.getStart(rewrittenImports),
        end: statement.end,
        text: "",
      })),
    );
  const bound = bindBuiltinFacades(body, bindings);
  body = bound.source;
  for (const specifier of bound.imports) imports.add(specifier);
  const globals = rawAnalysis.globals;
  const preparedAnalysis = analyzeWorkerFactory(body, "signalbox/worker-hooks.js");
  const located = (report: typeof preparedAnalysis.functionConstructors) => ({
    count: report.count,
    sites: report.sites.map((site) => ({
      ...site,
      line: site.line + 1 + (globals.length ? 1 : 0),
    })),
  });
  const index = unique(body, "__signalboxIndex");
  const exported = [...input.exports];
  const workerSource =
    `export function instantiate(${bindings}){\n` +
    (globals.length
      ? `const ${globals.map((name) => `${name}=${bindings}.globals[${JSON.stringify(name)}]`).join(",")};\n`
      : "") +
    body +
    "\n" +
    input.initializers.join("") +
    `return {get launch(){return ${input.launch}},read(${index}){switch(${index}){${exported.map(([, local], position) => `case ${position}:return ${local};`).join("")}default:throw new RangeError("BUNDLE_WORKER_EXPORT_INVALID");}}};\n}\n` +
    // The main module can declare the same names as realm globals; its lexical scope cannot read them.
    `export function parentGlobals(){return globalThis;}\n`;
  const mainFile = parse(input.mainSource);
  const replacements = new Map<string, string>();
  const mainEdits: { start: number; end: number; text: string }[] = [];
  for (const statement of mainFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== input.workerImport
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings))
      throw shape();
    for (const item of clause.namedBindings.elements) {
      const position = exported.findIndex(
        ([name]) => name === (item.propertyName ?? item.name).text,
      );
      if (position < 0) throw shape();
      replacements.set(item.name.text, `(${instance}.read(${position}))`);
    }
    mainEdits.push({ start: statement.getStart(mainFile), end: statement.end, text: "" });
  }
  for (const statement of mainFile.statements)
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const item of statement.exportClause.elements)
        if (replacements.has((item.propertyName ?? item.name).text))
          throw new Error("BUNDLE_WORKER_LIVE_REEXPORT_UNSUPPORTED");
  // Bind by symbol before deleting import declarations so nested shadowing stays untouched.
  let mainSource = rewriteLexicalReferences(input.mainSource, replacements);
  const rewritten = parse(mainSource);
  mainSource = replace(
    mainSource,
    rewritten.statements
      .filter(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === input.workerImport,
      )
      .map((statement) => ({ start: statement.getStart(rewritten), end: statement.end, text: "" })),
  );
  if (mainEdits.length !== 1) throw shape();
  const namespace = unique(mainSource, "__signalboxNamespace");
  const namespaces = unique(mainSource, "__signalboxImports");
  const realm = unique(mainSource, "__signalboxRealm");
  const prefix =
    `import {instantiate as ${instantiate},parentGlobals as ${parentGlobals}} from ${JSON.stringify(input.workerImport)};\n` +
    `const ${realm}=${parentGlobals}();\n` +
    `const ${namespace}=value=>{const ns=${realm}.Object.create(null);${realm}.Object.defineProperty(ns,"default",{value,enumerable:true});for(const key of ${realm}.Object.keys(value))if(key!=="default")${realm}.Object.defineProperty(ns,key,{get:()=>value[key],enumerable:true});return ns;};\n` +
    `const ${namespaces}=${realm}.Object.create(null);\n` +
    `const ${instance}=${instantiate}({globals:{${globals.map((name) => `[${JSON.stringify(name)}]:${name === "require" ? 'typeof require==="undefined"?undefined:require' : `${realm}.${name}`}`).join(",")}},imports:{${[
      ...imports,
    ]
      .sort()
      .map(
        (name) =>
          `get ${JSON.stringify(name)}(){return ${namespaces}[${JSON.stringify(name)}]??= ${namespace}(require(${JSON.stringify(name)}))}`,
      )
      .join(",")}}});\n`;
  return {
    workerSource,
    mainSource:
      input.banner && mainSource.startsWith(`${input.banner}\n`)
        ? `${input.banner}\n${prefix}${mainSource.slice(input.banner.length + 1)}`
        : prefix + mainSource,
    globals,
    imports: [...imports].sort(),
    computedGlobalAccess: located(preparedAnalysis.computedGlobalAccess),
    functionConstructors: located(preparedAnalysis.functionConstructors),
  };
}

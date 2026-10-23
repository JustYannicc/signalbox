import { applySourceEdits } from "../../claude-bunfs/source-edits.ts";
import ts from "typescript-legacy";
import type { BuiltinSource } from "./source.ts";

const invalid = () => new Error("NODE_BUILTIN_WORKER_FACTORY_SHAPE_CHANGED");
const parse = (source: BuiltinSource) =>
  ts.createSourceFile(source.name, source.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const replace = applySourceEdits;
function member(node: ts.Expression, key: string) {
  return ts.isPropertyAccessExpression(node) && node.name.text === key
    ? node.expression
    : undefined;
}
function boundImport(node: ts.Expression, parameter: string) {
  const named =
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  const base = member(node, "default");
  const access =
    base ??
    (named && ts.isElementAccessExpression(node) && ts.isElementAccessExpression(node.expression)
      ? node.expression
      : node);
  if (
    !ts.isElementAccessExpression(access) ||
    !access.argumentExpression ||
    !ts.isStringLiteral(access.argumentExpression)
  )
    return undefined;
  const root = member(access.expression, "imports");
  return root && ts.isIdentifier(root) && root.text === parameter
    ? {
        specifier: access.argumentExpression.text,
        imported: base ? "default" : access === node ? "*" : named!,
      }
    : undefined;
}

/** Undo only the generated factory plumbing for the existing builtin data-flow scanner.
 * Every analyzed body is sliced from verified published bytes, including deferred functions. */
export function workerFactoryBuiltinSources(sources: readonly BuiltinSource[]) {
  const worker = sources.find((source) => source.name === "signalbox/worker-hooks.js");
  if (!worker) return sources;
  const file = parse(worker);
  const factory = file.statements[0];
  if (!factory || !ts.isFunctionDeclaration(factory) || factory.name?.text !== "instantiate")
    throw invalid();
  const parameter = factory.parameters[0]?.name;
  if (
    file.statements.length !== 1 ||
    !factory.body ||
    factory.parameters.length !== 1 ||
    !parameter ||
    !ts.isIdentifier(parameter)
  )
    throw invalid();
  const returned = factory.body.statements.at(-1);
  if (
    !returned ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isObjectLiteralExpression(returned.expression)
  )
    throw invalid();
  const launch = returned.expression.properties.find(
    (property) => ts.isGetAccessorDeclaration(property) && property.name.getText(file) === "launch",
  );
  const launchReturn =
    launch && ts.isGetAccessorDeclaration(launch) ? launch.body?.statements[0] : undefined;
  if (
    !launchReturn ||
    !ts.isReturnStatement(launchReturn) ||
    !launchReturn.expression ||
    !ts.isIdentifier(launchReturn.expression)
  )
    throw invalid();
  const launchName = launchReturn.expression.text;
  const read = returned.expression.properties.find(
    (property) => ts.isMethodDeclaration(property) && property.name.getText(file) === "read",
  );
  if (!read || !ts.isMethodDeclaration(read) || !read.body) throw invalid();
  const switched = read.body.statements[0];
  if (!switched || !ts.isSwitchStatement(switched)) throw invalid();
  const exported = new Map<number, string>();
  for (const clause of switched.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) continue;
    const value = clause.statements[0];
    if (
      !ts.isNumericLiteral(clause.expression) ||
      clause.statements.length !== 1 ||
      !value ||
      !ts.isReturnStatement(value) ||
      !value.expression ||
      !ts.isIdentifier(value.expression)
    )
      throw invalid();
    exported.set(Number(clause.expression.text), value.expression.text);
  }
  const edits: { start: number; end: number; text: string }[] = [
    { start: returned.getStart(file), end: returned.end, text: "" },
  ];
  for (const statement of factory.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declarations = statement.declarationList.declarations;
    if (
      declarations.every(
        (declaration) =>
          declaration.initializer &&
          ts.isElementAccessExpression(declaration.initializer) &&
          (() => {
            const root = member(declaration.initializer.expression, "globals");
            return root && ts.isIdentifier(root) && root.text === parameter.text;
          })(),
      )
    ) {
      edits.push({ start: statement.getStart(file), end: statement.end, text: "" });
      continue;
    }
    const imports = declarations.map(
      (declaration) =>
        declaration.initializer && boundImport(declaration.initializer, parameter.text),
    );
    if (imports.every(Boolean)) {
      edits.push({
        start: statement.getStart(file),
        end: statement.end,
        text: declarations
          .map((declaration, index) => {
            if (!ts.isIdentifier(declaration.name)) throw invalid();
            const imported = imports[index]!;
            return `import ${imported.imported === "default" ? declaration.name.text : imported.imported === "*" ? `* as ${declaration.name.text}` : `{${JSON.stringify(imported.imported)} as ${declaration.name.text}}`} from ${JSON.stringify(imported.specifier)};`;
          })
          .join(""),
      });
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      ts.isStringLiteral(node.name) &&
      node.parameters.length === 2
    ) {
      const statement = node.body.statements[0];
      if (
        node.body.statements.length === 1 &&
        statement &&
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression)
      ) {
        const expression = statement.expression;
        const imported = boundImport(expression.right, parameter.text);
        const module = member(expression.left, "exports");
        if (imported && imported.imported === "default" && module && ts.isIdentifier(module)) {
          edits.push({
            start: node.body.getStart(file),
            end: node.body.end,
            text: `{var bridge=globalThis[Symbol.for("signalbox.nodeBridge.v1")];${module.text}.exports=bridge.require(${JSON.stringify(imported.specifier)});}`,
          });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  const start = factory.body.getStart(file) + 1,
    end = factory.body.end - 1;
  const body = replace(worker.source, edits);
  const editedPrefix = replace(
    worker.source.slice(0, start),
    edits.filter((edit) => edit.end <= start),
  );
  const editedSuffix = worker.source.slice(end);
  const unwrapped =
    body.slice(editedPrefix.length, body.length - editedSuffix.length) +
    `\nexport {${[...exported].map(([index, local]) => `${local} as __signalboxAnalysis${index}`).join(",")},${launchName} as launch};`;
  return sources.map((source) => {
    if (source === worker) return { ...source, source: unwrapped };
    const main = parse(source);
    const factoryImport = main.statements.find(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "./worker-hooks.js",
    );
    if (!factoryImport || !ts.isImportDeclaration(factoryImport)) return source;
    const clause = factoryImport.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw invalid();
    const imported = clause.namedBindings.elements.find(
      (item) => (item.propertyName ?? item.name).text === "instantiate",
    );
    if (!imported) throw invalid();
    const mainEdits = [{ start: factoryImport.getStart(main), end: factoryImport.end, text: "" }];
    let instance: string | undefined;
    for (const statement of main.statements) {
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
        continue;
      const declaration = statement.declarationList.declarations[0]!;
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === imported.name.text &&
        ts.isIdentifier(declaration.name)
      ) {
        if (instance) throw invalid();
        instance = declaration.name.text;
        mainEdits.push({ start: statement.getStart(main), end: statement.end, text: "" });
      }
    }
    if (!instance) throw invalid();
    const used = new Set<number>();
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "read" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === instance
      ) {
        const index = node.arguments[0];
        if (
          node.arguments.length !== 1 ||
          !index ||
          !ts.isNumericLiteral(index) ||
          !exported.has(Number(index.text))
        )
          throw invalid();
        used.add(Number(index.text));
        mainEdits.push({
          start: node.getStart(main),
          end: node.end,
          text: `__signalboxAnalysis${index.text}`,
        });
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(main);
    return {
      ...source,
      source:
        `import {${[...used].map((index) => `__signalboxAnalysis${index}`).join(",")}} from "./worker-hooks.js";\n` +
        replace(source.source, mainEdits),
    };
  });
}

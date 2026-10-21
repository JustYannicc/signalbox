import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import ts from "typescript-legacy";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import type { NodeBuiltinAmbiguity } from "./coverage.ts";

type Origin = "module" | "factory" | "require" | "bridge";
export interface BuiltinSource {
  readonly name: string;
  readonly source: string;
}
const literal = (node: ts.Node | undefined) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)
    ? unwrap(node.expression)
    : node;
}
function member(node: ts.Expression) {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return { target: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node))
    return { target: node.expression, name: literal(node.argumentExpression) };
  return undefined;
}

/** Scan every packaged JS file, including builtin facades already folded into a bundle. */
export function scanBuiltinSource(input: BuiltinSource) {
  const file = ts.createSourceFile(input.name, input.source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(file, "parseDiagnostics");
  if (Array.isArray(diagnostics) && diagnostics.length)
    throw new Error(`NODE_BUILTIN_SOURCE_INVALID: ${input.name}`);
  const bindings = new ScopedBindings<Origin>(file);
  const references = new Set<string>();
  const ambiguities: NodeBuiltinAmbiguity[] = [];
  const globalName = (node: ts.Expression, name: string) =>
    ts.isIdentifier(node) && node.text === name && !bindings.lookup(node);
  const origin = (raw: ts.Expression): Origin | undefined => {
    const node = unwrap(raw);
    if (ts.isIdentifier(node)) {
      const binding = bindings.lookup(node);
      return binding ? binding.origin : node.text === "require" ? "require" : undefined;
    }
    const property = member(node);
    if (property?.name === "createRequire" && origin(property.target) === "module")
      return "factory";
    if (property?.name === "require" && origin(property.target) === "bridge") return "require";
    if (
      property?.name === "require" &&
      (globalName(property.target, "globalThis") || globalName(property.target, "global"))
    )
      return "require";
    if (ts.isElementAccessExpression(node) && globalName(node.expression, "globalThis")) {
      const key = node.argumentExpression;
      if (
        key &&
        ts.isCallExpression(key) &&
        literal(key.arguments[0]) === "signalbox.nodeBridge.v1"
      ) {
        const symbolFor = member(key.expression);
        if (symbolFor?.name === "for" && globalName(symbolFor.target, "Symbol")) return "bridge";
      }
    }
    if (ts.isCallExpression(node)) {
      if (origin(node.expression) === "factory") return "require";
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ["module", "node:module"].includes(literal(node.arguments[0]) ?? "")
      )
        return "module";
      if (
        origin(node.expression) === "require" &&
        ["module", "node:module"].includes(literal(node.arguments[0]) ?? "")
      )
        return "module";
    }
    return undefined;
  };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = literal(statement.moduleSpecifier);
    if (!specifier || !["module", "node:module"].includes(specifier)) continue;
    const clause = statement.importClause;
    if (clause?.name) bindings.setOrigin(clause.name, "module");
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      bindings.setOrigin(clause.namedBindings.name, "module");
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const item of clause.namedBindings.elements)
        if ((item.propertyName ?? item.name).text === "createRequire")
          bindings.setOrigin(item.name, "factory");
  }
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(file);
  for (let pass = 0; pass <= declarations.length; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const value = origin(declaration.initializer);
      if (value && ts.isIdentifier(declaration.name)) {
        if (bindings.lookup(declaration.name)?.origin !== value) {
          bindings.setOrigin(declaration.name, value);
          changed = true;
        }
      } else if (value === "module" && ts.isObjectBindingPattern(declaration.name)) {
        for (const item of declaration.name.elements) {
          if (
            ts.isIdentifier(item.name) &&
            (item.propertyName ?? item.name).getText(file) === "createRequire" &&
            bindings.lookup(item.name)?.origin !== "factory"
          ) {
            bindings.setOrigin(item.name, "factory");
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  const add = (node: ts.Node, argument: ts.Expression | undefined, kind: string) => {
    const specifier = literal(argument);
    if (specifier !== undefined) {
      if (specifier.startsWith("node:") || NodeModule.isBuiltin(specifier))
        references.add(specifier);
    } else {
      const point = file.getLineAndCharacterOfPosition(node.getStart(file));
      ambiguities.push({
        kind,
        module: input.name,
        line: point.line + 1,
        column: point.character + 1,
        specifier: argument?.getText(file).slice(0, 160) ?? "<missing>",
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node, node.moduleSpecifier as ts.Expression, "static-import");
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, node.arguments[0], "dynamic-import");
      else if (origin(node.expression) === "require")
        add(node, node.arguments[0], "dynamic-require");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    name: input.name,
    bytes: Buffer.byteLength(input.source),
    sha256: NodeCrypto.createHash("sha256").update(input.source).digest("hex"),
    requiredSpecifiers: [...references].sort(),
    ambiguities,
  };
}

import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import ts from "typescript-legacy";
import {
  isNodeRequireCall,
  nodeRequireBindings,
  unwrapRequireExpression as unwrap,
} from "../../claude-bunfs/release-inventory-require.ts";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import type { NodeBuiltinAmbiguity } from "./coverage.ts";

type Origin = "module" | "factory" | "require" | "bridge" | "process" | "builtin-loader";
export interface BuiltinSource {
  readonly name: string;
  readonly source: string;
  readonly format?: number;
}
const literal = (node: ts.Node | undefined) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;
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
  const requires = nodeRequireBindings(file, input.format);
  const references = new Set<string>();
  const ambiguities: NodeBuiltinAmbiguity[] = [];
  const globalName = (node: ts.Expression, name: string) =>
    ts.isIdentifier(node) && node.text === name && !bindings.lookup(node);
  const origin = (raw: ts.Expression): Origin | undefined => {
    const node = unwrap(raw);
    if (ts.isIdentifier(node)) {
      const binding = bindings.lookup(node);
      if (binding?.origin) return binding.origin;
      const required = requires.lookup(node);
      if (required ? required.origin : node.text === "require") return "require";
      return !binding && node.text === "process" ? "process" : undefined;
    }
    const property = member(node);
    if (property?.name === "getBuiltinModule" && origin(property.target) === "process")
      return "builtin-loader";
    if (property?.name === "createRequire" && origin(property.target) === "module")
      return "factory";
    if (property?.name === "require" && origin(property.target) === "bridge") return "require";
    if (
      property?.name === "process" &&
      (globalName(property.target, "globalThis") || globalName(property.target, "global"))
    )
      return "process";
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
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isNodeRequireCall(node, requires) ||
        origin(node.expression) === "require"
      ) {
        const specifier = literal(node.arguments[0]);
        if (["module", "node:module"].includes(specifier ?? "")) return "module";
        if (["process", "node:process"].includes(specifier ?? "")) return "process";
      }
    }
    return undefined;
  };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = literal(statement.moduleSpecifier);
    if (["process", "node:process"].includes(specifier ?? "")) {
      const clause = statement.importClause;
      if (clause?.name) bindings.setOrigin(clause.name, "process");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        bindings.setOrigin(clause.namedBindings.name, "process");
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const item of clause.namedBindings.elements)
          if ((item.propertyName ?? item.name).text === "getBuiltinModule")
            bindings.setOrigin(item.name, "builtin-loader");
      continue;
    }
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
      } else if (
        (value === "module" || value === "process") &&
        ts.isObjectBindingPattern(declaration.name)
      ) {
        const memberName = value === "module" ? "createRequire" : "getBuiltinModule";
        const memberOrigin = value === "module" ? "factory" : "builtin-loader";
        for (const item of declaration.name.elements) {
          const key = item.propertyName ?? item.name;
          if (
            ts.isIdentifier(item.name) &&
            (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
            key.text === memberName &&
            bindings.lookup(item.name)?.origin !== memberOrigin
          ) {
            bindings.setOrigin(item.name, memberOrigin);
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
      if (
        kind === "builtin-module" ||
        specifier.startsWith("node:") ||
        NodeModule.isBuiltin(specifier)
      )
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
      else if (origin(node.expression) === "builtin-loader")
        add(node, node.arguments[0], "builtin-module");
      else if (isNodeRequireCall(node, requires) || origin(node.expression) === "require")
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

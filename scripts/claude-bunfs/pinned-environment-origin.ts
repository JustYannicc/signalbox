import ts from "typescript-legacy";
import type { ScopedBindings } from "./release-inventory-scope.ts";

export type Origin = readonly string[];
// An unknown value may alias process or its environment, so it prevents pinning.
export const UNKNOWN_ORIGIN = "?";

export function pinnedEnvironmentSourceId(namespace: string, path: string) {
  return `${namespace}\0${path}`;
}

export function parsePinnedEnvironmentSourceId(value: string) {
  const separator = value.indexOf("\0");
  return separator < 0
    ? { namespace: "bun-graph", path: value }
    : { namespace: value.slice(0, separator), path: value.slice(separator + 1) };
}

function isImportMetaRequire(node: ts.Node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "require" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  );
}

export function processRequireOrigin(
  node: ts.Node,
  bindings: ScopedBindings<never>,
): Origin | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
  const callee = node.expression;
  const isRequire =
    isImportMetaRequire(callee) ||
    (ts.isIdentifier(callee) &&
      callee.text === "require" &&
      bindings.lookup(callee) === undefined) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "require" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "module" &&
      bindings.lookup(callee.expression) === undefined);
  if (!isRequire) return undefined;
  const argument = node.arguments[0];
  if (!argument || !ts.isStringLiteralLike(argument)) return [UNKNOWN_ORIGIN];
  return argument.text === "process" || argument.text === "node:process" ? [] : undefined;
}

export function bindingPath(declaration: ts.Identifier, variable: ts.VariableDeclaration) {
  if (ts.isIdentifier(variable.name)) return [];
  const path: string[] = [];
  let current: ts.Node = declaration;
  while (current !== variable.name) {
    const parent = current.parent;
    if (ts.isBindingElement(parent)) {
      if (parent.dotDotDotToken) return undefined;
      const key = parent.propertyName
        ? ts.isStringLiteralLike(parent.propertyName) || ts.isNumericLiteral(parent.propertyName)
          ? parent.propertyName.text
          : UNKNOWN_ORIGIN
        : ts.isIdentifier(parent.name)
          ? parent.name.text
          : UNKNOWN_ORIGIN;
      path.unshift(key);
      current = parent;
      continue;
    }
    if (ts.isObjectBindingPattern(parent) || ts.isArrayBindingPattern(parent)) {
      current = parent;
      continue;
    }
    return undefined;
  }
  return path;
}

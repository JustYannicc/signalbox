import ts from "typescript-legacy";
import { hasLocalDeclaration, staticProperty, symbolOf, unwrap } from "./worker-factory-lexical.ts";
import type { AnalysisContext } from "./worker-factory-lexical.ts";

export interface GlobalObject {
  readonly root: string;
  readonly alias: string | undefined;
}

export type IntrinsicValue = "function" | "eval";
const globalObjectNames = new Set(["globalThis", "global", "self", "window"]);

export function aliasFor(
  symbol: ts.Symbol | undefined,
  aliases: ReadonlyMap<ts.Symbol, string>,
): string | undefined {
  return symbol ? aliases.get(symbol) : undefined;
}

export function globalObjectFor(
  expression: ts.Expression,
  context: AnalysisContext,
  aliases: ReadonlyMap<ts.Symbol, string>,
): GlobalObject | undefined {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const symbol = symbolOf(node, context.checker);
    if (globalObjectNames.has(node.text) && !hasLocalDeclaration(symbol, context.file))
      return { root: node.text, alias: undefined };
    const root = aliasFor(symbol, aliases);
    return root ? { root, alias: node.text } : undefined;
  }
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    globalObjectNames.has(staticProperty(node) ?? "")
  ) {
    const parent = globalObjectFor(node.expression, context, aliases);
    return parent ? { root: parent.root, alias: parent.alias ?? parent.root } : undefined;
  }
  return undefined;
}

export function globalRootFor(
  expression: ts.Expression,
  context: AnalysisContext,
  aliases: ReadonlyMap<ts.Symbol, string>,
): GlobalObject | undefined {
  const root = expressionPath(expression).root;
  return root ? globalObjectFor(root, context, aliases) : undefined;
}

export function callableExpression(
  expression: ts.Expression,
  context: AnalysisContext,
  functionAliases: ReadonlyMap<ts.Symbol, string>,
): boolean {
  const node = unwrap(expression);
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node))
    return true;
  if (ts.isIdentifier(node)) {
    const symbol = symbolOf(node, context.checker);
    if (aliasFor(symbol, functionAliases)) return true;
    return Boolean(
      symbol?.declarations?.some(
        (declaration) =>
          ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration),
      ),
    );
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const member = staticProperty(node);
    const receiver = unwrap(node.expression);
    if (member === "prototype" && ts.isIdentifier(receiver) && receiver.text === "Function")
      return !hasLocalDeclaration(symbolOf(receiver, context.checker), context.file);
    if (member === "constructor" && callableExpression(receiver, context, functionAliases))
      return true;
    if (member === "constructor" && ts.isCallExpression(receiver)) {
      const callee = unwrap(receiver.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        callee.name.text === "getPrototypeOf" &&
        receiver.arguments.some((argument) =>
          callableExpression(argument, context, functionAliases),
        )
      )
        return true;
    }
    const path = expressionPath(node);
    if (path.root?.text === "Function" && path.parts.includes("prototype"))
      return !hasLocalDeclaration(symbolOf(path.root, context.checker), context.file);
    if (path.parts.filter((part) => part === "constructor").length >= 2) return true;
  }
  return false;
}

export function expressionPath(expression: ts.Expression): {
  readonly root?: ts.Identifier;
  readonly parts: ReadonlyArray<string | undefined>;
} {
  const parts: Array<string | undefined> = [];
  let node = unwrap(expression);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    parts.unshift(staticProperty(node));
    node = unwrap(node.expression);
  }
  return { ...(ts.isIdentifier(node) ? { root: node } : {}), parts };
}

export function intrinsicValue(
  expression: ts.Expression,
  kind: IntrinsicValue,
  context: AnalysisContext,
  globalAliases: ReadonlyMap<ts.Symbol, string>,
  intrinsicAliases: ReadonlyMap<ts.Symbol, string>,
): string | undefined {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const symbol = symbolOf(node, context.checker);
    const intrinsicName = kind === "function" ? "Function" : "eval";
    if (node.text === intrinsicName && !hasLocalDeclaration(symbol, context.file)) return "direct";
    return aliasFor(symbol, intrinsicAliases);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const intrinsicName = kind === "function" ? "Function" : "eval";
    if (
      staticProperty(node) === intrinsicName &&
      globalObjectFor(node.expression, context, globalAliases)
    )
      return "global-property";
    if (kind === "function" && staticProperty(node) === "constructor") {
      const receiver = unwrap(node.expression);
      const path = expressionPath(receiver);
      if (
        path.root?.text === "Function" &&
        !hasLocalDeclaration(symbolOf(path.root, context.checker), context.file) &&
        path.parts.includes("prototype")
      )
        return "constructor-property";
      if (callableExpression(receiver, context, new Map())) return "constructor-property";
      if (path.parts.filter((part) => part === "constructor").length >= 2)
        return "constructor-chain";
    }
  }
  if (kind === "function" && ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind") {
      const value = intrinsicValue(
        callee.expression,
        kind,
        context,
        globalAliases,
        intrinsicAliases,
      );
      if (value) return "bound-alias";
    }
  }
  return undefined;
}

export function collectAliases(context: AnalysisContext): {
  readonly globalObjects: ReadonlyMap<ts.Symbol, string>;
  readonly functions: ReadonlyMap<ts.Symbol, string>;
  readonly evals: ReadonlyMap<ts.Symbol, string>;
} {
  const globalObjects = new Map<ts.Symbol, string>();
  const functions = new Map<ts.Symbol, string>();
  const evals = new Map<ts.Symbol, string>();
  const targets: Array<{ name: ts.Identifier; expression: ts.Expression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      targets.push({ name: node.name, expression: node.initializer });
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      targets.push({ name: node.left, expression: node.right });
    ts.forEachChild(node, visit);
  };
  visit(context.file);

  for (let pass = 0; pass < targets.length + 1; pass++) {
    let changed = false;
    for (const target of targets) {
      const symbol = symbolOf(target.name, context.checker);
      if (!symbol) continue;
      const root = globalObjectFor(target.expression, context, globalObjects);
      if (root && !globalObjects.has(symbol)) {
        globalObjects.set(symbol, root.root);
        changed = true;
      }
      const functionAlias = intrinsicValue(
        target.expression,
        "function",
        context,
        globalObjects,
        functions,
      );
      if (functionAlias && !functions.has(symbol)) {
        functions.set(symbol, functionAlias);
        changed = true;
      }
      const evalAlias = intrinsicValue(target.expression, "eval", context, globalObjects, evals);
      if (evalAlias && !evals.has(symbol)) {
        evals.set(symbol, evalAlias);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { globalObjects, functions, evals };
}
export function callKind(
  node: ts.CallExpression | ts.NewExpression,
  value: string,
  context: AnalysisContext,
  aliases: ReturnType<typeof collectAliases>,
): string {
  const form = ts.isNewExpression(node) ? "new" : "call";
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) {
    const symbol = symbolOf(callee, context.checker);
    if (callee.text === "Function" && !hasLocalDeclaration(symbol, context.file))
      return `direct-${form}`;
    if (aliasFor(symbol, aliases.functions)) return `alias-${form}`;
  }
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    if (
      staticProperty(callee) === "Function" &&
      globalObjectFor(callee.expression, context, aliases.globalObjects)
    )
      return `global-property-${form}`;
    if (staticProperty(callee) === "constructor") return `constructor-property-${form}`;
  }
  if (value === "constructor-property" || value === "constructor-chain") return `${value}-${form}`;
  return `alias-${form}`;
}

import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";

export type GuardedAccess = "read" | "call" | "construct";

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

export function expressionPath(
  expression: ts.Expression,
): { readonly root: string; readonly path: ReadonlyArray<string> } | undefined {
  if (ts.isIdentifier(expression)) return { root: expression.text, path: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const base = expressionPath(expression.expression);
    return base ? { ...base, path: [...base.path, expression.name.text] } : undefined;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const base = expressionPath(expression.expression);
    const key = stringValue(expression.argumentExpression);
    return base && key !== undefined ? { ...base, path: [...base.path, key] } : undefined;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

interface BindingLookup {
  lookup(identifier: ts.Identifier): { readonly declaration: ts.Identifier } | undefined;
}

interface GuardTarget {
  readonly root: string;
  readonly rootIdentifier: ts.Identifier;
  readonly path: ReadonlyArray<string>;
  readonly bindings: BindingLookup;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function matchesAccess(expression: ts.Expression, target: GuardTarget): boolean {
  const actual = expressionPath(unwrap(expression));
  if (
    actual?.root !== target.root ||
    actual.path.length !== target.path.length ||
    !actual.path.every((part, index) => part === target.path[index])
  )
    return false;
  const actualRoot = rootIdentifier(unwrap(expression));
  return Boolean(
    actualRoot &&
    target.bindings.lookup(actualRoot)?.declaration ===
      target.bindings.lookup(target.rootIdentifier)?.declaration,
  );
}

function undefinedCheck(
  expression: ts.Expression,
  target: GuardTarget,
  access: GuardedAccess,
): { readonly whenTrue: boolean; readonly whenFalse: boolean } | undefined {
  const value = unwrap(expression);
  if (!ts.isBinaryExpression(value)) return undefined;
  const left = unwrap(value.left);
  const right = unwrap(value.right);
  const leftTypeof = ts.isTypeOfExpression(left) && matchesAccess(left.expression, target);
  const rightTypeof = ts.isTypeOfExpression(right) && matchesAccess(right.expression, target);
  const leftAccess = matchesAccess(left, target);
  const rightAccess = matchesAccess(right, target);
  const literal = leftTypeof || leftAccess ? right : rightTypeof || rightAccess ? left : undefined;
  if (!literal) return undefined;
  const text =
    ts.isStringLiteralLike(literal) || ts.isNoSubstitutionTemplateLiteral(literal)
      ? literal.text
      : ts.isIdentifier(literal) && literal.text === "undefined"
        ? "undefined"
        : undefined;
  if (text === undefined) return undefined;
  const equality =
    value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const inequality =
    value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
    value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality && !inequality) return undefined;
  const typeOfTest = leftTypeof || rightTypeof;
  if (typeOfTest) {
    if (text === "function")
      return equality ? { whenTrue: true, whenFalse: false } : { whenTrue: false, whenFalse: true };
    if (text === "undefined" && access === "read")
      return inequality
        ? { whenTrue: true, whenFalse: false }
        : { whenTrue: false, whenFalse: true };
    return undefined;
  }
  if (access === "read" && text === "undefined")
    return inequality ? { whenTrue: true, whenFalse: false } : { whenTrue: false, whenFalse: true };
  return undefined;
}

function availability(
  expression: ts.Expression,
  target: GuardTarget,
  access: GuardedAccess,
): { readonly whenTrue: boolean; readonly whenFalse: boolean } {
  const value = unwrap(expression);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = availability(value.operand, target, access);
    return { whenTrue: nested.whenFalse, whenFalse: nested.whenTrue };
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    const left = availability(value.left, target, access);
    const right = availability(value.right, target, access);
    return {
      whenTrue: left.whenTrue || right.whenTrue,
      whenFalse: left.whenFalse && right.whenFalse,
    };
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const left = availability(value.left, target, access);
    const right = availability(value.right, target, access);
    return {
      whenTrue: left.whenTrue && right.whenTrue,
      whenFalse: left.whenFalse || right.whenFalse,
    };
  }
  const check = undefinedCheck(value, target, access);
  if (check) return check;
  // A truthy member read proves presence, but a call also requires it to be a
  // function. Only typeof checks or optional calls prove callable support.
  if (access === "read" && matchesAccess(value, target))
    return { whenTrue: true, whenFalse: false };
  return { whenTrue: false, whenFalse: false };
}

function containsNode(parent: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === parent) return true;
  return false;
}

function sameExpression(left: ts.Expression, right: ts.Expression): boolean {
  const normalize = (expression: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      expression = expression.expression;
    return expression;
  };
  return normalize(left) === normalize(right);
}

/** Return true only when this exact leaf is proven available at its use site. */
export function isGuarded(
  file: ts.SourceFile,
  node: ts.Expression,
  root: string,
  path: ReadonlyArray<string>,
  access: GuardedAccess = "read",
  bindings?: BindingLookup,
): boolean {
  const targetRoot = rootIdentifier(node);
  if (!targetRoot || targetRoot.text !== root) return false;
  const lexicalBindings = bindings ?? new ScopedBindings<never>(file);
  const target: GuardTarget = { root, rootIdentifier: targetRoot, path, bindings: lexicalBindings };
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.expression === current) {
      // Optional call protects this exact callee. `Bun?.foo()` only checks Bun,
      // so its optional token lives on the property access, not the call.
      if (
        parent.questionDotToken &&
        sameExpression(parent.expression, node) &&
        (access === "call" || access === "construct")
      )
        return true;
      current = parent;
      continue;
    }
    if (ts.isIfStatement(parent)) {
      const thenBranch = containsNode(parent.thenStatement, current);
      const elseBranch = parent.elseStatement ? containsNode(parent.elseStatement, current) : false;
      const implication = availability(parent.expression, target, access);
      if ((thenBranch && implication.whenTrue) || (elseBranch && implication.whenFalse))
        return true;
    }
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return false;
    current = parent;
  }
  return false;
}

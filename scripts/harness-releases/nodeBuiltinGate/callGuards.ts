import ts from "typescript-legacy";
import type { NodeBuiltinFunctionCall } from "./coverage.ts";

function unparen(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function memberChain(
  raw: ts.Expression,
  builtinRoot: string,
  safe = false,
): readonly string[] | undefined {
  const node = unparen(raw);
  if (ts.isIdentifier(node) && node.text === builtinRoot) return [node.text];
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const target = unparen(node.expression);
  const property = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  if (property === undefined) return undefined;
  const access = ts.isPropertyAccessExpression(node) ? "." : "[]";
  if (
    builtinRoot === "process" &&
    property === "process" &&
    ts.isIdentifier(target) &&
    (target.text === "globalThis" || target.text === "global")
  )
    return [target.text, access, property];
  const receiver = memberChain(target, builtinRoot, safe);
  if (!receiver) return undefined;
  const root =
    receiver.length === 1 ||
    (receiver.length === 3 &&
      receiver[2] === "process" &&
      (receiver[0] === "globalThis" || receiver[0] === "global"));
  if (safe && !root && !node.questionDotToken) return undefined;
  return [...receiver, access, property];
}

/** Only immediate guards qualify; aliases and deferred execution stay required. */
export function builtinCallGuard(
  call: ts.CallExpression | ts.NewExpression,
  builtinRoot: string,
  resolvedMemberPath: readonly string[],
): NodeBuiltinFunctionCall["guard"] {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = memberChain(call.expression, builtinRoot);
  if (!callee || callee.length === 1) return undefined;
  // A member alias can share the builtin's name without being the builtin object.
  const memberPath = callee
    .slice(callee[0] === builtinRoot ? 1 : 3)
    .filter((_part, index) => index % 2 === 1);
  if (JSON.stringify(memberPath) !== JSON.stringify(resolvedMemberPath)) return undefined;
  const evidence = (node: ts.Node, kind: NonNullable<NodeBuiltinFunctionCall["guard"]>["kind"]) => {
    const file = call.getSourceFile();
    const point = file.getLineAndCharacterOfPosition(node.getStart(file));
    return {
      kind,
      expression: node.getText(file),
      line: point.line + 1,
      column: point.character + 1,
    };
  };
  if (call.questionDotToken && memberChain(call.expression, builtinRoot, true))
    return evidence(call, "optional-call");

  // Optional constant lookups may catch absence instead of testing the property first.
  let lookup: ts.Node = call;
  while (
    ts.isParenthesizedExpression(lookup.parent) ||
    ((ts.isPropertyAccessExpression(lookup.parent) ||
      ts.isElementAccessExpression(lookup.parent)) &&
      lookup.parent.expression === lookup)
  )
    lookup = lookup.parent;
  if (
    ts.isBinaryExpression(lookup.parent) &&
    lookup.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    lookup.parent.right === lookup
  )
    lookup = lookup.parent;
  const statement = lookup.parent;
  if (ts.isExpressionStatement(statement) && ts.isBlock(statement.parent)) {
    const block = statement.parent,
      attempt = block.parent;
    if (
      block.statements.length === 1 &&
      ts.isTryStatement(attempt) &&
      attempt.tryBlock === block &&
      attempt.catchClause?.block.statements.length === 0 &&
      !attempt.finallyBlock
    )
      return evidence(attempt, "caught-call");
  }

  let consequent: ts.Expression = call;
  while (ts.isParenthesizedExpression(consequent.parent)) consequent = consequent.parent;
  const parent = consequent.parent;
  const condition =
    ts.isConditionalExpression(parent) && parent.whenTrue === consequent
      ? parent.condition
      : ts.isBinaryExpression(parent) &&
          parent.right === consequent &&
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? parent.left
        : undefined;
  const test = condition && unparen(condition);
  if (!test || !ts.isBinaryExpression(test)) return undefined;
  const operator = test.operatorToken.kind;
  const equal =
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === ts.SyntaxKind.EqualsEqualsToken;
  const unequal =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsToken;
  const left = unparen(test.left);
  const right = unparen(test.right);
  for (const [value, expected] of [
    [left, right],
    [right, left],
  ] as const) {
    const typeTest = ts.isTypeOfExpression(value) && ts.isStringLiteralLike(expected);
    const matches = typeTest
      ? (expected.text === "function" && equal) || (expected.text === "undefined" && unequal)
      : expected.kind === ts.SyntaxKind.NullKeyword &&
        operator === ts.SyntaxKind.ExclamationEqualsToken;
    const chain = matches && memberChain(typeTest ? value.expression : value, builtinRoot, true);
    if (chain && JSON.stringify(chain) === JSON.stringify(callee))
      return evidence(test, "feature-test");
  }
  return undefined;
}

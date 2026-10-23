import ts from "typescript-legacy";
import type { NodeBuiltinFunctionCall } from "./coverage.ts";
import { sameReference, type BuiltinReference } from "./referenceValues.ts";

/** A guard applies to this call site, never to every call of the same builtin. */
export function builtinCallGuard(
  call: ts.CallExpression | ts.NewExpression,
  callee: BuiltinReference,
  reference: (expression: ts.Expression) => BuiltinReference | undefined,
): NodeBuiltinFunctionCall["guard"] {
  const unparen = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return expression;
  };
  const matches = (expression: ts.Expression) => sameReference(reference(expression), callee);
  const evidence = (node: ts.Node, kind: "feature-test" | "optional-call") => {
    const file = call.getSourceFile();
    const point = file.getLineAndCharacterOfPosition(node.getStart(file));
    return {
      kind,
      expression: node.getText(file),
      line: point.line + 1,
      column: point.character + 1,
    };
  };

  // Optional receivers alone do not protect an absent final method or Function.call target.
  if (ts.isCallExpression(call) && call.questionDotToken && matches(call.expression))
    return evidence(call, "optional-call");

  const guardedTest = (raw: ts.Expression, truthy: boolean): ts.Expression | undefined => {
    const test = unparen(raw);
    if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken)
      return guardedTest(test.operand, !truthy);
    if (!ts.isBinaryExpression(test)) return undefined;
    const operator = test.operatorToken.kind;
    if (
      (truthy && operator === ts.SyntaxKind.AmpersandAmpersandToken) ||
      (!truthy && operator === ts.SyntaxKind.BarBarToken)
    )
      return guardedTest(test.left, truthy) ?? guardedTest(test.right, truthy);

    const equal =
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const unequal =
      operator === ts.SyntaxKind.ExclamationEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (!equal && !unequal) return undefined;
    const equalBranch = truthy === equal;
    const left = unparen(test.left);
    const right = unparen(test.right);
    for (const [value, expected] of [
      [left, right],
      [right, left],
    ] as const) {
      if (
        ts.isTypeOfExpression(value) &&
        ts.isStringLiteralLike(expected) &&
        matches(value.expression) &&
        ((expected.text === "function" && equalBranch) ||
          (expected.text === "undefined" && !equalBranch))
      )
        return test;
      // Strict null comparisons also admit undefined, so only loose null checks suffice.
      if (
        (operator === ts.SyntaxKind.ExclamationEqualsToken ||
          operator === ts.SyntaxKind.EqualsEqualsToken) &&
        expected.kind === ts.SyntaxKind.NullKeyword &&
        !equalBranch &&
        matches(value)
      )
        return test;
    }
    return undefined;
  };

  for (let child: ts.Node = call; child.parent; child = child.parent) {
    const parent = child.parent;
    // A function may escape and run after the enclosing feature test.
    if (ts.isFunctionLike(parent)) break;
    let test: ts.Expression | undefined;
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue) test = guardedTest(parent.condition, true);
      if (child === parent.whenFalse) test = guardedTest(parent.condition, false);
    } else if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement) test = guardedTest(parent.expression, true);
      if (child === parent.elseStatement) test = guardedTest(parent.expression, false);
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        test = guardedTest(parent.left, true);
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        test = guardedTest(parent.left, false);
    }
    if (test) return evidence(test, "feature-test");
  }
  return undefined;
}

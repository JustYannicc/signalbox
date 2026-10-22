import ts from "typescript-legacy";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import {
  bindingIdentity,
  bundledMember,
  memberOnBinding,
  unwrapBundledExpression,
} from "./bundledFacadeShape.ts";

export type BundledHelperKind = "commonjs" | "interop";

function outerFunction(
  expression: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  if (!expression) return undefined;
  const value = unwrapBundledExpression(expression);
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : undefined;
}

function returnedFunction(body: ts.ConciseBody): ts.FunctionLikeDeclaration | undefined {
  if (!ts.isBlock(body)) return outerFunction(body);
  const statement = body.statements[0];
  if (body.statements.length !== 1 || !statement || !ts.isReturnStatement(statement))
    return undefined;
  return statement.expression ? outerFunction(statement.expression) : undefined;
}

function commaTail(raw: ts.Expression): ts.Expression {
  let expression = unwrapBundledExpression(raw);
  while (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  )
    expression = unwrapBundledExpression(expression.right);
  return expression;
}

function memberProperty(property: ts.ObjectLiteralElementLike | undefined) {
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  const name = property.name;
  const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
  const initializer = property.initializer;
  return {
    name: key,
    empty: ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0,
  };
}

function isAssignedEmptyExports(
  raw: ts.Expression,
  moduleParameter: ts.Identifier,
  bindings: ScopedBindings<unknown>,
) {
  const expression = unwrapBundledExpression(raw);
  const assignment = ts.isPropertyAccessExpression(expression)
    ? unwrapBundledExpression(expression.expression)
    : undefined;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== "exports" ||
    !assignment ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    bindingIdentity(assignment.left, bindings) !== moduleParameter
  )
    return false;
  const moduleObject = unwrapBundledExpression(assignment.right);
  if (!ts.isObjectLiteralExpression(moduleObject) || moduleObject.properties.length !== 1)
    return false;
  const exportsProperty = memberProperty(moduleObject.properties[0]);
  return Boolean(exportsProperty && exportsProperty.name === "exports" && exportsProperty.empty);
}

function invokesCommonJsCallback(
  expression: ts.Expression,
  callbackParameter: ts.Identifier,
  moduleParameter: ts.Identifier,
  bindings: ScopedBindings<unknown>,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments.length === 2) {
      const callee = commaTail(node.expression);
      if (
        ts.isElementAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindingIdentity(callee.expression, bindings) === callbackParameter &&
        node.arguments[0] &&
        isAssignedEmptyExports(node.arguments[0], moduleParameter, bindings) &&
        node.arguments[1] &&
        ts.isIdentifier(node.arguments[1]) &&
        bindingIdentity(node.arguments[1], bindings) === moduleParameter
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function resetsCommonJsCache<T>(
  statement: ts.TryStatement,
  moduleParameter: ts.Identifier,
  bindings: ScopedBindings<T>,
): boolean {
  const caught = statement.catchClause?.variableDeclaration?.name;
  const body = statement.catchClause?.block.statements;
  const thrown = body?.[0];
  if (
    !statement.catchClause ||
    statement.finallyBlock ||
    !caught ||
    !ts.isIdentifier(caught) ||
    bindingIdentity(caught, bindings) !== caught ||
    body?.length !== 1 ||
    !thrown ||
    !ts.isThrowStatement(thrown)
  )
    return false;

  const expression = unwrapBundledExpression(thrown.expression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    !ts.isIdentifier(expression.right) ||
    bindingIdentity(expression.right, bindings) !== caught
  )
    return false;

  const reset = unwrapBundledExpression(expression.left);
  return (
    ts.isBinaryExpression(reset) &&
    reset.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(reset.left) &&
    bindingIdentity(reset.left, bindings) === moduleParameter &&
    ts.isNumericLiteral(reset.right) &&
    Number(reset.right.text) === 0
  );
}

function commonJsHelperShape<T>(
  expression: ts.Expression | undefined,
  bindings: ScopedBindings<T>,
  requireCacheReset: boolean,
): boolean {
  const outer = outerFunction(expression);
  const callbackParameter = outer?.parameters[0]?.name;
  const moduleParameter = outer?.parameters[1]?.name;
  if (
    !outer ||
    outer.parameters.length !== 2 ||
    !callbackParameter ||
    !ts.isIdentifier(callbackParameter) ||
    !moduleParameter ||
    !ts.isIdentifier(moduleParameter) ||
    !outer.body
  )
    return false;
  const inner = returnedFunction(outer.body);
  if (
    !inner ||
    inner.parameters.length !== 0 ||
    !inner.body ||
    !ts.isBlock(inner.body) ||
    inner.body.statements.length !== 1 ||
    !inner.body.statements[0]
  )
    return false;

  const statement = inner.body.statements[0];
  let returned: ts.Expression | undefined;
  if (ts.isReturnStatement(statement)) returned = statement.expression;
  else if (ts.isTryStatement(statement)) {
    const attempt = statement.tryBlock.statements[0];
    if (
      statement.tryBlock.statements.length !== 1 ||
      !attempt ||
      !ts.isReturnStatement(attempt) ||
      !attempt.expression ||
      (requireCacheReset && !resetsCommonJsCache(statement, moduleParameter, bindings))
    )
      return false;
    returned = attempt.expression;
  }
  if (!returned) return false;

  return (
    memberOnBinding(commaTail(returned), moduleParameter, "exports", bindings) &&
    invokesCommonJsCallback(returned, callbackParameter, moduleParameter, bindings)
  );
}

export function isCommonJsHelper<T>(
  expression: ts.Expression | undefined,
  bindings: ScopedBindings<T>,
): boolean {
  return commonJsHelperShape(expression, bindings, true);
}

/** Keeps a near-match visible so its facade calls fail closed as unknown. */
export function isPossibleCommonJsHelper<T>(
  expression: ts.Expression | undefined,
  bindings: ScopedBindings<T>,
): boolean {
  return commonJsHelperShape(expression, bindings, false);
}

function isGlobalDefineProperty<T>(expression: ts.Expression, bindings: ScopedBindings<T>) {
  const access = bundledMember(expression);
  return (
    access?.name === "defineProperty" &&
    ts.isIdentifier(access.receiver) &&
    access.receiver.text === "Object" &&
    !bindings.lookup(access.receiver)
  );
}

function hasDefaultDefinition<T>(
  expression: ts.Expression,
  moduleParameter: ts.Identifier,
  defineAliases: ReadonlySet<ts.Identifier>,
  bindings: ScopedBindings<T>,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments.length >= 3) {
      const callee = unwrapBundledExpression(node.expression);
      const declaration = ts.isIdentifier(callee) ? bindingIdentity(callee, bindings) : undefined;
      const alias = declaration && defineAliases.has(declaration);
      const property = node.arguments[1];
      const descriptor = node.arguments[2];
      const descriptorValue = descriptor ? unwrapBundledExpression(descriptor) : undefined;
      if (
        (alias || isGlobalDefineProperty(callee, bindings)) &&
        property &&
        ts.isStringLiteralLike(property) &&
        property.text === "default" &&
        descriptorValue &&
        ts.isObjectLiteralExpression(descriptorValue) &&
        descriptorValue.properties.some((item) => {
          const field = memberProperty(item);
          const value = ts.isPropertyAssignment(item) ? item.initializer : undefined;
          return (
            field?.name === "value" &&
            value &&
            ts.isIdentifier(value) &&
            bindingIdentity(value, bindings) === moduleParameter
          );
        })
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

export function isInteropHelper<T>(
  expression: ts.Expression | undefined,
  defineAliases: ReadonlySet<ts.Identifier>,
  bindings: ScopedBindings<T>,
): boolean {
  const helper = outerFunction(expression);
  const moduleParameter = helper?.parameters[0]?.name;
  if (!helper || !moduleParameter || !ts.isIdentifier(moduleParameter) || !helper.body)
    return false;
  const statement = ts.isBlock(helper.body) ? helper.body.statements[0] : undefined;
  const returned = ts.isBlock(helper.body)
    ? helper.body.statements.length === 1 && statement && ts.isReturnStatement(statement)
      ? statement.expression
      : undefined
    : helper.body;
  return Boolean(
    returned && hasDefaultDefinition(returned, moduleParameter, defineAliases, bindings),
  );
}

export function isGlobalDefinePropertyAlias<T>(
  expression: ts.Expression,
  bindings: ScopedBindings<T>,
) {
  return isGlobalDefineProperty(expression, bindings);
}

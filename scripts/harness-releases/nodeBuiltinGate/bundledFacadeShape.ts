import * as NodeModule from "node:module";
import ts from "typescript-legacy";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";

export function unwrapBundledExpression(raw: ts.Expression): ts.Expression {
  let expression = raw;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

export function bundledMember(expression: ts.Expression) {
  expression = unwrapBundledExpression(expression);
  if (ts.isPropertyAccessExpression(expression))
    return { receiver: expression.expression, name: expression.name.text };
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const argument = expression.argumentExpression;
    if (ts.isStringLiteralLike(argument))
      return { receiver: expression.expression, name: argument.text };
  }
  return undefined;
}

export function bindingIdentity<T>(identifier: ts.Identifier, bindings: ScopedBindings<T>) {
  return bindings.lookup(identifier)?.declaration;
}

function globalName<T>(expression: ts.Expression, name: string, bindings: ScopedBindings<T>) {
  return ts.isIdentifier(expression) && expression.text === name && !bindings.lookup(expression);
}

function bridgeExpression<T>(expression: ts.Expression, bindings: ScopedBindings<T>): boolean {
  const bridge = unwrapBundledExpression(expression);
  if (!ts.isElementAccessExpression(bridge) || !bridge.argumentExpression) return false;
  const key = unwrapBundledExpression(bridge.argumentExpression);
  if (!ts.isCallExpression(key) || !key.arguments[0]) return false;
  const symbolFor = unwrapBundledExpression(key.expression);
  return (
    ts.isPropertyAccessExpression(symbolFor) &&
    symbolFor.name.text === "for" &&
    globalName(symbolFor.expression, "Symbol", bindings) &&
    ts.isStringLiteralLike(key.arguments[0]) &&
    key.arguments[0].text === "signalbox.nodeBridge.v1" &&
    globalName(bridge.expression, "globalThis", bindings)
  );
}

export function bundledBuiltinSpecifier(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isStringLiteralLike(expression)) return undefined;
  return NodeModule.isBuiltin(expression.text) ? expression.text.replace(/^node:/u, "") : undefined;
}

function bridgeRequire<T>(
  expression: ts.Expression,
  bridgeBinding: ts.Identifier,
  bindings: ScopedBindings<T>,
): string | undefined {
  const call = unwrapBundledExpression(expression);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return undefined;
  const access = bundledMember(call.expression);
  if (!access || access.name !== "require") return undefined;
  const receiver = unwrapBundledExpression(access.receiver);
  const isLocalBridge =
    ts.isIdentifier(receiver) && bindingIdentity(receiver, bindings) === bridgeBinding;
  if (!isLocalBridge && !bridgeExpression(receiver, bindings)) return undefined;
  return bundledBuiltinSpecifier(call.arguments[0]);
}

export function memberOnBinding<T>(
  expression: ts.Expression,
  binding: ts.Identifier,
  name: string,
  bindings: ScopedBindings<T>,
): boolean {
  const access = bundledMember(expression);
  return (
    access?.name === name &&
    ts.isIdentifier(access.receiver) &&
    bindingIdentity(access.receiver, bindings) === binding
  );
}

function bridgeInstallationGuard<T>(
  statement: ts.Statement,
  bridge: ts.Identifier,
  bindings: ScopedBindings<T>,
): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = unwrapBundledExpression(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isIdentifier(condition.operand) ||
    bindingIdentity(condition.operand, bindings) !== bridge ||
    !ts.isBlock(statement.thenStatement)
  )
    return false;
  const [declaration, code, thrown] = statement.thenStatement.statements;
  if (
    statement.thenStatement.statements.length !== 3 ||
    !declaration ||
    !ts.isVariableStatement(declaration) ||
    declaration.declarationList.declarations.length !== 1 ||
    !code ||
    !ts.isExpressionStatement(code) ||
    !thrown ||
    !ts.isThrowStatement(thrown)
  )
    return false;
  const error = declaration.declarationList.declarations[0];
  if (!error || !ts.isIdentifier(error.name) || !error.initializer) return false;
  const created = unwrapBundledExpression(error.initializer);
  const assignment = unwrapBundledExpression(code.expression);
  const message = ts.isNewExpression(created) ? created.arguments?.[0] : undefined;
  return (
    bindingIdentity(error.name, bindings) === error.name &&
    ts.isNewExpression(created) &&
    globalName(created.expression, "Error", bindings) &&
    created.arguments?.length === 1 &&
    message !== undefined &&
    ts.isStringLiteralLike(message) &&
    ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    memberOnBinding(assignment.left, error.name, "code", bindings) &&
    ts.isStringLiteralLike(assignment.right) &&
    assignment.right.text === "NODE_BRIDGE_NOT_INSTALLED" &&
    ts.isIdentifier(thrown.expression) &&
    bindingIdentity(thrown.expression, bindings) === error.name
  );
}

function bridgeFacadeSpecifier<T>(
  callback: ts.FunctionLikeDeclaration,
  bindings: ScopedBindings<T>,
): { readonly specifier: string; readonly verified: boolean } | undefined {
  const exportsParameter = callback.parameters[0]?.name;
  const moduleParameter = callback.parameters[1]?.name;
  if (
    !callback.body ||
    !ts.isBlock(callback.body) ||
    !exportsParameter ||
    !ts.isIdentifier(exportsParameter) ||
    !moduleParameter ||
    !ts.isIdentifier(moduleParameter) ||
    callback.parameters.length !== 2 ||
    callback.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)
  )
    return undefined;

  const declarationStatement = callback.body.statements[0];
  const exportStatement = callback.body.statements.at(-1);
  if (
    callback.body.statements.length < 2 ||
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.declarationList.declarations.length !== 1
  )
    return undefined;
  const bridgeDeclaration = declarationStatement.declarationList.declarations[0];
  if (
    !bridgeDeclaration ||
    !ts.isIdentifier(bridgeDeclaration.name) ||
    !bridgeDeclaration.initializer ||
    !bridgeExpression(bridgeDeclaration.initializer, bindings) ||
    bindingIdentity(bridgeDeclaration.name, bindings) !== bridgeDeclaration.name ||
    !exportStatement ||
    !ts.isExpressionStatement(exportStatement) ||
    !ts.isBinaryExpression(exportStatement.expression) ||
    exportStatement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !memberOnBinding(exportStatement.expression.left, moduleParameter, "exports", bindings)
  )
    return undefined;

  if (bindingIdentity(exportsParameter, bindings) !== exportsParameter) return undefined;
  const specifier = bridgeRequire(
    exportStatement.expression.right,
    bridgeDeclaration.name,
    bindings,
  );
  if (!specifier) return undefined;
  const guard = callback.body.statements[1];
  return {
    specifier,
    verified:
      callback.body.statements.length === 2 ||
      Boolean(
        callback.body.statements.length === 3 &&
        guard &&
        bridgeInstallationGuard(guard, bridgeDeclaration.name, bindings),
      ),
  };
}

export function bundledFacadeCandidate<T>(
  expression: ts.Expression | undefined,
  bindings: ScopedBindings<T>,
):
  | {
      readonly specifier: string;
      readonly verified: boolean;
      readonly bindings: readonly ts.Identifier[];
    }
  | undefined {
  if (!expression) return undefined;
  const bindingPath: ts.Identifier[] = [];
  const visited = new Set<ts.Identifier>();
  let object = unwrapBundledExpression(expression);
  while (ts.isIdentifier(object)) {
    const declaration = bindingIdentity(object, bindings);
    if (!declaration || visited.has(declaration) || !ts.isVariableDeclaration(declaration.parent))
      return undefined;
    const variable = declaration.parent;
    if (variable.name !== declaration || !variable.initializer) return undefined;
    visited.add(declaration);
    bindingPath.push(declaration);
    object = unwrapBundledExpression(variable.initializer);
  }
  if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 1) return undefined;
  const property = object.properties[0];
  if (!property || !ts.isFunctionLike(property)) return undefined;
  const candidate = bridgeFacadeSpecifier(property, bindings);
  return candidate ? { ...candidate, bindings: bindingPath } : undefined;
}

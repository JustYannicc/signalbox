import ts from "typescript-legacy";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import {
  bindingIdentity,
  bundledFacadeCandidate,
  unwrapBundledExpression,
} from "./bundledFacadeShape.ts";
import {
  isCommonJsHelper,
  isPossibleCommonJsHelper,
  isGlobalDefinePropertyAlias,
  isInteropHelper,
  type BundledHelperKind,
} from "./bundledHelperShape.ts";

interface HelperBinding {
  readonly kind: BundledHelperKind;
  readonly roots: ReadonlySet<ts.Identifier>;
  readonly verified: boolean;
}

function assignmentTarget(
  node: ts.Node,
  bindings: ScopedBindings<unknown>,
  assignments: Map<ts.Identifier, number>,
): void {
  if (ts.isIdentifier(node)) {
    const declaration = bindingIdentity(node, bindings);
    if (declaration) assignments.set(declaration, (assignments.get(declaration) ?? 0) + 1);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) assignmentTarget(element, bindings, assignments);
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property))
        assignmentTarget(property.initializer, bindings, assignments);
      else if (ts.isShorthandPropertyAssignment(property))
        assignmentTarget(property.name, bindings, assignments);
      else if (ts.isSpreadAssignment(property))
        assignmentTarget(property.expression, bindings, assignments);
    }
  }
}

function isAssignmentOperator(kind: ts.SyntaxKind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Resolves only verified esbuild helper and bridge-facade data flows. */
export function bundledBuiltinFlow<T>(file: ts.SourceFile, bindings: ScopedBindings<T>) {
  const assignments = new Map<ts.Identifier, number>();
  const simpleAssignments = new Set<ts.Identifier>();
  const declarations: ts.VariableDeclaration[] = [];
  const facadePaths = new Map<ts.Identifier, ReadonlySet<ts.Identifier>>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      assignmentTarget(node.left, bindings, assignments);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const declaration = bindingIdentity(node.left, bindings);
        if (declaration) simpleAssignments.add(declaration);
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      assignmentTarget(node.operand, bindings, assignments);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const initializers = new Map<ts.Identifier, number>();
  for (const variable of declarations) {
    if (!variable.initializer || !ts.isIdentifier(variable.name)) continue;
    const declaration = bindingIdentity(variable.name, bindings);
    if (declaration) initializers.set(declaration, (initializers.get(declaration) ?? 0) + 1);
  }
  const reassigned = new Set(
    [...assignments]
      .filter(
        ([declaration, count]) =>
          !(
            count === 1 &&
            simpleAssignments.has(declaration) &&
            ts.isVariableDeclaration(declaration.parent) &&
            !initializers.has(declaration)
          ),
      )
      .map(([declaration]) => declaration),
  );

  for (const [declaration, count] of initializers) {
    if (count > 1) reassigned.add(declaration);
  }
  const defineAliases = new Set<ts.Identifier>();
  for (const declaration of declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      !reassigned.has(declaration.name) &&
      isGlobalDefinePropertyAlias(declaration.initializer, bindings)
    )
      defineAliases.add(declaration.name);
  }

  const possible = new Map<ts.Identifier, HelperBinding>();
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const commonJs = isCommonJsHelper(declaration.initializer, bindings);
    const kind =
      commonJs || isPossibleCommonJsHelper(declaration.initializer, bindings)
        ? "commonjs"
        : isInteropHelper(declaration.initializer, defineAliases, bindings)
          ? "interop"
          : undefined;
    if (kind)
      possible.set(declaration.name, {
        kind,
        roots: new Set([declaration.name]),
        verified: kind === "interop" || commonJs,
      });
  }

  for (let pass = 0; pass <= declarations.length; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isIdentifier(unwrapBundledExpression(declaration.initializer)) ||
        possible.has(declaration.name)
      )
        continue;
      const source = unwrapBundledExpression(declaration.initializer) as ts.Identifier;
      const sourceDeclaration = bindingIdentity(source, bindings);
      const inherited = sourceDeclaration && possible.get(sourceDeclaration);
      if (!inherited) continue;
      possible.set(declaration.name, {
        kind: inherited.kind,
        verified: inherited.verified,
        roots: new Set([...inherited.roots, declaration.name]),
      });
      changed = true;
    }
    if (!changed) break;
  }

  const helper = (expression: ts.Expression, allowReassigned: boolean) => {
    const value = unwrapBundledExpression(expression);
    if (!ts.isIdentifier(value)) return undefined;
    const declaration = bindingIdentity(value, bindings);
    const candidate = declaration && possible.get(declaration);
    if (!candidate) return undefined;
    return allowReassigned ||
      (candidate.verified && [...candidate.roots].every((root) => !reassigned.has(root)))
      ? candidate.kind
      : undefined;
  };

  const facade = (expression: ts.Expression | undefined, allowReassigned: boolean) => {
    const candidate = bundledFacadeCandidate(expression, bindings);
    if (!candidate) return undefined;
    const facadeRoot = candidate.bindings[0];
    const affected = facadeRoot ? facadePaths.get(facadeRoot) : undefined;
    if (
      !allowReassigned &&
      (!candidate.verified ||
        [...candidate.bindings, ...(affected ?? [])].some((binding) => reassigned.has(binding)))
    )
      return undefined;
    return candidate;
  };

  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const candidate = bundledFacadeCandidate(declaration.initializer, bindings);
    if (!candidate) continue;
    const path = new Set(candidate.bindings);
    for (const binding of candidate.bindings) facadePaths.set(binding, path);
  }

  return {
    helperKind: (expression: ts.Expression) => helper(expression, false),
    possibleHelperKind: (expression: ts.Expression) => helper(expression, true),
    facadeSpecifier: (expression: ts.Expression | undefined) =>
      facade(expression, false)?.specifier,
    possibleFacadeSpecifier: (expression: ts.Expression | undefined) =>
      facade(expression, true)?.specifier,
    isReassigned: (identifier: ts.Identifier) => {
      const declaration = bindingIdentity(identifier, bindings);
      return Boolean(declaration && reassigned.has(declaration));
    },
  };
}

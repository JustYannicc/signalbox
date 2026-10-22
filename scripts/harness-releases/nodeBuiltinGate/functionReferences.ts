import ts from "typescript-legacy";
import {
  isNodeRequireCall,
  type RequireBindings,
} from "../../claude-bunfs/release-inventory-require.ts";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import { bundledBuiltinFlow } from "./bundledReferences.ts";
import {
  builtinMemberReference,
  builtinSpecifier,
  isBuiltinReference,
  literal,
  moduleReference,
  sameReference,
  uncertainBuiltinReference,
  isUncertainBuiltinReference,
  staticMember,
  type BuiltinFunctionAnalysisOrigin,
  type BuiltinReference,
} from "./referenceValues.ts";

export { isBuiltinReference } from "./referenceValues.ts";
export { builtinMemberReference } from "./referenceValues.ts";
export type { BuiltinFunctionAnalysisOrigin, BuiltinReference } from "./referenceValues.ts";

/** Resolves static builtin references through scoped imports, requires and aliases. */
export function resolveBuiltinFunctionReferences(
  file: ts.SourceFile,
  bindings: ScopedBindings<BuiltinFunctionAnalysisOrigin>,
  requires: RequireBindings,
) {
  const bundled = bundledBuiltinFlow(file, bindings);
  const globalName = (node: ts.Expression, name: string) =>
    ts.isIdentifier(node) && node.text === name && !bindings.lookup(node);

  const reference = (raw: ts.Expression | undefined): BuiltinReference | undefined => {
    if (!raw) return undefined;
    if (ts.isAwaitExpression(raw)) {
      const awaited = reference(raw.expression);
      if (awaited?.kind === "dynamic-import-promise") return moduleReference(awaited.specifier);
      if (awaited?.kind === "unknown-import-promise")
        return { kind: "dynamic-module", specifier: awaited.specifier };
      return awaited;
    }
    if (ts.isParenthesizedExpression(raw)) return reference(raw.expression);
    if (ts.isBinaryExpression(raw) && raw.operatorToken.kind === ts.SyntaxKind.CommaToken)
      return reference(raw.right);
    if (ts.isIdentifier(raw)) {
      const binding = bindings.lookup(raw);
      if (isBuiltinReference(binding?.origin)) {
        const origin = binding.origin;
        return bundled.isReassigned(raw) ? uncertainBuiltinReference(origin) : origin;
      }
      if (binding?.origin === "bridge")
        return bundled.isReassigned(raw)
          ? { kind: "dynamic-node-bridge" }
          : { kind: "node-bridge" };
      if (requires.modules.lookup(raw)?.origin)
        return bundled.isReassigned(raw)
          ? { kind: "dynamic-module-loader" }
          : { kind: "module-loader" };
      const required = requires.lookup(raw);
      if (required)
        return required.origin
          ? bundled.isReassigned(raw)
            ? { kind: "dynamic-require" }
            : { kind: "require" }
          : undefined;
      if (binding) return undefined;
      if (raw.text === "process") return moduleReference("process");
      if (raw.text === "require") return { kind: "require" };
      return undefined;
    }

    const property = staticMember(raw);
    if (property) {
      if (
        property.name === "process" &&
        (globalName(property.target, "globalThis") || globalName(property.target, "global"))
      )
        return moduleReference("process");
      if (
        property.name === "require" &&
        (globalName(property.target, "globalThis") || globalName(property.target, "global"))
      )
        return { kind: "require" };
      return builtinMemberReference(reference(property.target), property.name);
    }

    if (!ts.isCallExpression(raw)) return undefined;
    if (raw.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? { kind: "dynamic-import-promise", specifier } : undefined;
    }
    const callee = reference(raw.expression);
    if (callee?.kind === "dynamic-require") {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? { kind: "dynamic-module", specifier } : undefined;
    }
    if (isNodeRequireCall(raw, requires) && (!callee || callee.kind === "require")) {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? moduleReference(specifier) : undefined;
    }
    if (
      callee?.kind === "member" &&
      callee.memberPath.length > 1 &&
      callee.memberPath.at(-1) === "bind"
    )
      return { ...callee, memberPath: callee.memberPath.slice(0, -1) };
    if (callee?.kind === "dynamic-member" && callee.memberPath.at(-1) === "bind")
      return { ...callee, memberPath: callee.memberPath.slice(0, -1) };
    if (callee?.kind === "commonjs-facade")
      return { kind: "bundled-module", specifier: callee.specifier };
    if (callee?.kind === "unknown-commonjs-facade")
      return { kind: "dynamic-module", specifier: callee.specifier };

    const helper = bundled.helperKind(raw.expression);
    if (helper === "commonjs") {
      const specifier = bundled.facadeSpecifier(raw.arguments[0]);
      if (specifier) return { kind: "commonjs-facade", specifier };
    }
    if (helper === "interop") {
      const input = raw.arguments[0] ? reference(raw.arguments[0]) : undefined;
      if (input?.kind === "bundled-module" || input?.kind === "dynamic-module") return input;
      if (input?.kind === "module") return moduleReference(input.specifier);
    }

    const possibleHelper = bundled.possibleHelperKind(raw.expression);
    if (possibleHelper === "commonjs") {
      const specifier = bundled.possibleFacadeSpecifier(raw.arguments[0]);
      if (specifier) return { kind: "unknown-commonjs-facade", specifier };
    }
    if (possibleHelper === "interop") {
      const input = raw.arguments[0] ? reference(raw.arguments[0]) : undefined;
      if (
        input &&
        "specifier" in input &&
        (input.kind === "bundled-module" ||
          input.kind === "dynamic-module" ||
          input.kind === "commonjs-facade" ||
          input.kind === "unknown-commonjs-facade")
      )
        return { kind: "dynamic-module", specifier: input.specifier };
    }

    const unknownFacade = bundled.possibleFacadeSpecifier(raw.arguments[0]);
    if (unknownFacade) return { kind: "unknown-commonjs-facade", specifier: unknownFacade };
    const bundledInput = raw.arguments
      .map(reference)
      .find((input) => input?.kind === "bundled-module" || input?.kind === "dynamic-module");
    if (
      bundledInput &&
      "specifier" in bundledInput &&
      (bundledInput.kind === "bundled-module" || bundledInput.kind === "dynamic-module")
    )
      return { kind: "dynamic-module", specifier: bundledInput.specifier };
    if (callee?.kind === "require") {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? moduleReference(specifier) : undefined;
    }
    if (callee?.kind === "require-factory") {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? moduleReference(specifier) : undefined;
    }
    if (
      callee?.kind === "member" &&
      callee.specifier === "module" &&
      callee.memberPath.length === 1 &&
      callee.memberPath[0] === "createRequire"
    )
      return { kind: "require-factory" };
    if (
      callee?.kind === "member" &&
      callee.specifier === "process" &&
      callee.memberPath.length === 1 &&
      callee.memberPath[0] === "getBuiltinModule"
    ) {
      const specifier = builtinSpecifier(literal(raw.arguments[0]));
      return specifier ? moduleReference(specifier) : undefined;
    }
    return undefined;
  };

  let changed = false;
  const assign = (name: ts.BindingName, value: BuiltinReference | undefined): void => {
    if (!value) return;
    if (ts.isIdentifier(name)) {
      const binding = bindings.lookup(name);
      if (!binding) return;
      const existing = binding.origin;
      const reassigned = bundled.isReassigned(name);
      // One ambiguous origin blocks the gate; retaining it lets branch joins converge.
      if (reassigned && isBuiltinReference(existing) && isUncertainBuiltinReference(existing))
        return;
      const next = reassigned ? uncertainBuiltinReference(value) : value;
      if (!isBuiltinReference(existing) || !sameReference(existing, next)) {
        bindings.setOrigin(binding.declaration, next);
        changed = true;
      }
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const item of name.elements) {
      if (item.dotDotDotToken) continue;
      const key = item.propertyName ?? item.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
        assign(item.name, builtinMemberReference(value, key.text));
    }
  };

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = builtinSpecifier(literal(statement.moduleSpecifier));
    if (!specifier) continue;
    const clause = statement.importClause;
    if (clause.name) assign(clause.name, moduleReference(specifier));
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      assign(clause.namedBindings.name, moduleReference(specifier));
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const item of clause.namedBindings.elements)
        assign(
          item.name,
          builtinMemberReference(moduleReference(specifier), (item.propertyName ?? item.name).text),
        );
  }

  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];
  const callbacks: { readonly parameter: ts.BindingName; readonly receiver: ts.Expression }[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      assignments.push(node);
    if (ts.isCallExpression(node)) {
      const property = staticMember(node.expression);
      const receiver = property?.target;
      const callback = node.arguments[0];
      if (
        property?.name === "then" &&
        receiver &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0]
      )
        callbacks.push({ parameter: callback.parameters[0].name, receiver });
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  for (let pass = 0; pass <= declarations.length + assignments.length + callbacks.length; pass++) {
    changed = false;
    for (const callback of callbacks) {
      const promise = reference(callback.receiver);
      if (promise?.kind === "dynamic-import-promise")
        assign(callback.parameter, moduleReference(promise.specifier));
      else if (promise?.kind === "unknown-import-promise")
        assign(callback.parameter, { kind: "dynamic-module", specifier: promise.specifier });
    }
    for (const declaration of declarations)
      if (declaration.initializer) assign(declaration.name, reference(declaration.initializer));
    for (const assignment of assignments) {
      const name = assignment.left;
      const declaration = ts.isIdentifier(name) ? bindings.lookup(name)?.declaration : undefined;
      if (declaration) assign(declaration, reference(assignment.right));
    }
    if (!changed) break;
  }

  return { reference };
}

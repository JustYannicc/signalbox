import ts from "typescript-legacy";
import type { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import type { RequireBindings } from "../../claude-bunfs/release-inventory-require.ts";
import { isBuiltinReference, type BuiltinFunctionAnalysisOrigin } from "./referenceValues.ts";

const unwrap = (node: ts.Expression) => {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
};
const printer = ts.createPrinter({ removeComments: true });
function printed(node: ts.Expression, file: ts.SourceFile) {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> =>
        ts.isStringLiteral(node)
          ? ts.factory.createStringLiteral(node.text)
          : ts.visitEachChild(node, visit, context);
      return (node) => ts.visitEachChild(node, visit, context);
    },
  ]);
  try {
    return printer.printNode(ts.EmitHint.Expression, transformed.transformed[0]!, file);
  } finally {
    transformed.dispose();
  }
}

/** Linking can wrap a generated require helper again. Every link must forward a known loader. */
export function verifiedRequireFallbacks(
  file: ts.SourceFile,
  bindings: ScopedBindings<BuiltinFunctionAnalysisOrigin>,
  requires: RequireBindings,
) {
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];
  const references = new Map<ts.Identifier, ts.Identifier[]>();
  let dynamicScope = false;
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      assignments.push(node);
    if (
      ts.isWithStatement(node) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "eval")
    )
      dynamicScope = true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ((ts.isIdentifier(node.left) && ["Proxy", "require"].includes(node.left.text)) ||
        (ts.isPropertyAccessExpression(node.left) &&
          ["Proxy", "require"].includes(node.left.name.text)))
    )
      dynamicScope = true;
    if (ts.isIdentifier(node)) {
      const declaration = bindings.lookup(node)?.declaration;
      if (declaration) {
        const uses = references.get(declaration) ?? [];
        uses.push(node);
        references.set(declaration, uses);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const initializers = new Set<ts.Node>();
  const loaders: ts.Identifier[] = [];
  if (dynamicScope) return { initializers, loaders };
  const candidates = new Map<
    ts.Identifier,
    {
      readonly value: ts.Expression;
      readonly helper?: ts.Expression;
      readonly underlying: ts.Identifier;
      readonly assignment?: ts.Identifier;
    }
  >();
  for (const declaration of declarations) {
    if (
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      (ts.isVariableStatement(declaration.parent.parent) &&
        ts
          .getModifiers(declaration.parent.parent)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    )
      continue;
    const initializer = unwrap(declaration.initializer);
    if (
      !ts.isCallExpression(initializer) ||
      initializer.arguments.length !== 1 ||
      !ts.isArrowFunction(unwrap(initializer.expression)) ||
      !ts.isFunctionExpression(initializer.arguments[0]!)
    )
      continue;
    const wrapper = unwrap(initializer.expression);
    if (!ts.isArrowFunction(wrapper) || ts.isBlock(wrapper.body)) continue;
    const body = unwrap(wrapper.body);
    const condition = ts.isConditionalExpression(body) ? unwrap(body.condition) : undefined;
    const typeOf =
      condition && ts.isBinaryExpression(condition) ? unwrap(condition.left) : undefined;
    const underlying =
      typeOf && ts.isTypeOfExpression(typeOf) ? unwrap(typeOf.expression) : undefined;
    if (!underlying || !ts.isIdentifier(underlying)) continue;
    const parameters: string[] = [];
    let shadowedGlobal = false;
    const findParameters = (node: ts.Node): void => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) parameters.push(node.name.text);
      if (ts.isIdentifier(node)) {
        const binding = bindings.lookup(node);
        if (node.text === "Proxy" && binding) shadowedGlobal = true;
      }
      ts.forEachChild(node, findParameters);
    };
    findParameters(initializer);
    if (parameters.length !== 4 || shadowedGlobal) continue;
    const [value, receiver, key, fallback] = parameters;
    const loader = underlying.text;
    const matches = ['<"u"', '!=="undefined"'].some((comparison) => {
      const condition = `typeof ${loader}${comparison}`;
      const expected = ts.createSourceFile(
        "esbuild-require.js",
        `(${value}=>${condition}?${loader}:typeof Proxy${comparison}?new Proxy(${value},{get:(${receiver},${key})=>(${condition}?${loader}:${receiver})[${key}]}):${value})(function(${fallback}){if(${condition})return ${loader}.apply(this,arguments);throw Error('Dynamic require of "'+${fallback}+'" is not supported')});`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const statement = expected.statements[0];
      return (
        statement &&
        ts.isExpressionStatement(statement) &&
        printed(initializer, file) === printed(statement.expression, expected)
      );
    });
    if (matches)
      candidates.set(declaration.name, { value: initializer, helper: initializer, underlying });
  }
  const exported = (declaration: ts.VariableDeclaration) =>
    ts.isVariableStatement(declaration.parent.parent) &&
    ts
      .getModifiers(declaration.parent.parent)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const declaration of declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isIdentifier(declaration.initializer) &&
      !exported(declaration)
    )
      candidates.set(declaration.name, {
        value: declaration.initializer,
        underlying: declaration.initializer,
      });
  }
  for (const assignment of assignments) {
    if (!ts.isIdentifier(assignment.left) || !ts.isIdentifier(assignment.right)) continue;
    const name = bindings.lookup(assignment.left)?.declaration;
    const declaration = name?.parent;
    if (
      !name ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer ||
      exported(declaration)
    )
      continue;
    candidates.set(name, {
      value: assignment.right,
      underlying: assignment.right,
      assignment: assignment.left,
    });
  }
  const known = (node: ts.Identifier, visiting = new Set<ts.Identifier>()): boolean => {
    const required = requires.lookup(node);
    const binding = bindings.lookup(node);
    const value = binding?.origin;
    if (
      required?.origin === true ||
      value === "require" ||
      (isBuiltinReference(value) && value.kind === "require")
    )
      return true;
    if (!binding) return node.text === "require";
    const candidate = candidates.get(binding.declaration);
    if (!candidate || visiting.has(binding.declaration)) return false;
    visiting.add(binding.declaration);
    return known(candidate.underlying, visiting);
  };
  for (const [name, candidate] of candidates)
    if (!known(candidate.underlying)) candidates.delete(name);
  const within = (node: ts.Node, ancestor: ts.Node) => {
    for (let current: ts.Node | undefined = node; current; current = current.parent)
      if (current === ancestor) return true;
    return false;
  };
  // An escaping helper invalidates the chain; its fallback body must still block analysis.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, candidate] of candidates) {
      const dependency = bindings.lookup(candidate.underlying)?.declaration;
      const safe = references.get(name)?.every((use) => {
        if (use === name || use === candidate.assignment) return true;
        let expression: ts.Expression = use;
        while (
          ts.isParenthesizedExpression(expression.parent) ||
          (ts.isBinaryExpression(expression.parent) &&
            expression.parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            expression.parent.right === expression)
        )
          expression = expression.parent;
        if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression)
          return true;
        return [...candidates.values()].some(
          (other) =>
            bindings.lookup(other.underlying)?.declaration === name && within(use, other.value),
        );
      });
      if (!safe || (dependency && !candidates.has(dependency) && !known(candidate.underlying))) {
        candidates.delete(name);
        changed = true;
      }
    }
  }
  for (const [name, candidate] of candidates) {
    if (candidate.helper) initializers.add(candidate.helper);
    loaders.push(name);
  }
  return { initializers, loaders };
}

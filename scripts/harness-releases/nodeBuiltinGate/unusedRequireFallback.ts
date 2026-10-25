import ts from "typescript-legacy";
import type { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";

const unwrap = (node: ts.Expression) => {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
};
const printer = ts.createPrinter({ removeComments: true });

/** Only esbuild's exact, unreferenced fallback is inert. An alias, export or call keeps it scanned. */
export function unusedRequireFallbacks<T>(file: ts.SourceFile, bindings: ScopedBindings<T>) {
  const declarations: ts.VariableDeclaration[] = [];
  const references = new Map<ts.Identifier, number>();
  let dynamicScope = false;
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
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
      ((ts.isIdentifier(node.left) && node.left.text === "Proxy") ||
        (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "Proxy"))
    )
      dynamicScope = true;
    if (ts.isIdentifier(node)) {
      const declaration = bindings.lookup(node)?.declaration;
      if (declaration) references.set(declaration, (references.get(declaration) ?? 0) + 1);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const unused = new Set<ts.Node>();
  if (dynamicScope) return unused;
  for (const declaration of declarations) {
    if (
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      references.get(declaration.name) !== 1 ||
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
    const parameters: string[] = [];
    let shadowedProxy = false;
    const findParameters = (node: ts.Node): void => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) parameters.push(node.name.text);
      if (ts.isIdentifier(node) && node.text === "Proxy" && bindings.lookup(node))
        shadowedProxy = true;
      ts.forEachChild(node, findParameters);
    };
    findParameters(initializer);
    if (parameters.length !== 4 || shadowedProxy) continue;
    const [value, receiver, key, fallback] = parameters;
    const expected = ts.createSourceFile(
      "esbuild-require.js",
      `(${value}=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(${value},{get:(${receiver},${key})=>(typeof require<"u"?require:${receiver})[${key}]}):${value})(function(${fallback}){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+${fallback}+'" is not supported')});`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const statement = expected.statements[0];
    if (!statement || !ts.isExpressionStatement(statement)) continue;
    if (
      printer.printNode(ts.EmitHint.Expression, initializer, file) ===
      printer.printNode(ts.EmitHint.Expression, statement.expression, expected)
    )
      unused.add(initializer);
  }
  return unused;
}

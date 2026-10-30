import ts from "typescript-legacy";

const invalid = () => new Error("NODE_BUILTIN_WORKER_FACTORY_SHAPE_CHANGED");

/** Restore only generated live reads; arbitrary functions remain ordinary source bodies. */
export function restoreWorkerFactoryReads(
  main: ts.SourceFile,
  instance: string,
  exported: ReadonlyMap<number, string>,
) {
  const readCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "read" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === instance;
  const readers = new Map<string, ts.VariableStatement>();
  const declarations = new Set<ts.VariableStatement>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const statement of main.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
      continue;
    const declaration = statement.declarationList.declarations[0]!;
    const initializer = declaration.initializer;
    if (!initializer || !ts.isArrowFunction(initializer) || !readCall(initializer.body)) continue;
    const parameter = initializer.parameters[0];
    const forwarded = initializer.body.arguments[0];
    if (
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      !ts.isIdentifier(declaration.name) ||
      initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      initializer.parameters.length !== 1 ||
      !parameter ||
      !ts.isIdentifier(parameter.name) ||
      parameter.initializer ||
      parameter.dotDotDotToken ||
      initializer.body.arguments.length !== 1 ||
      !forwarded ||
      !ts.isIdentifier(forwarded) ||
      forwarded.text !== parameter.name.text ||
      readers.has(declaration.name.text)
    )
      throw invalid();
    readers.set(declaration.name.text, statement);
    declarations.add(statement);
    edits.push({ start: statement.getStart(main), end: statement.end, text: "" });
  }
  const used = new Set<number>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && declarations.has(node)) return;
    const compact =
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      readers.has(node.expression.text);
    if (ts.isCallExpression(node) && (readCall(node) || compact)) {
      const index = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        !index ||
        !ts.isNumericLiteral(index) ||
        !exported.has(Number(index.text))
      )
        throw invalid();
      used.add(Number(index.text));
      edits.push({
        start: node.getStart(main),
        end: node.end,
        text: `__signalboxAnalysis${index.text}`,
      });
      return;
    }
    // The producer reserves this name across every lexical scope, so aliases cannot escape or shadow.
    if (ts.isIdentifier(node) && readers.has(node.text)) throw invalid();
    ts.forEachChild(node, walk);
  };
  walk(main);
  return { used, edits };
}

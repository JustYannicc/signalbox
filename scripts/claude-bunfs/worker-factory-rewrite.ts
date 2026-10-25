import { applySourceEdits } from "./source-edits.ts";
import ts from "typescript-legacy";
import {
  createContext,
  isJSDoc,
  isReference,
  referenceSymbol,
  symbolOf,
} from "./worker-factory-lexical.ts";

function isInsideImport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (ts.isImportDeclaration(current)) return true;
  return false;
}

function isReferenceCallCallee(node: ts.Identifier): boolean {
  let expression: ts.Node = node;
  while (expression.parent && ts.isParenthesizedExpression(expression.parent))
    expression = expression.parent;
  const parent = expression.parent;
  return (
    (ts.isCallExpression(parent) && parent.expression === expression) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === expression)
  );
}

export function rewriteLexicalReferences(
  source: string,
  replacements: ReadonlyMap<string, string>,
  filename = "worker-factory.js",
): string {
  if (!replacements.size) return source;
  const context = createContext(source, filename);
  const importedSymbols = new Map<ts.Symbol, string>();
  for (const statement of context.file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.isTypeOnly) continue;
    if (clause.name && replacements.has(clause.name.text)) {
      const symbol = symbolOf(clause.name, context.checker);
      if (symbol) importedSymbols.set(symbol, replacements.get(clause.name.text)!);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && replacements.has(bindings.name.text)) {
      const symbol = symbolOf(bindings.name, context.checker);
      if (symbol) importedSymbols.set(symbol, replacements.get(bindings.name.text)!);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly || !replacements.has(element.name.text)) continue;
        const symbol = symbolOf(element.name, context.checker);
        if (symbol) importedSymbols.set(symbol, replacements.get(element.name.text)!);
      }
    }
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (isJSDoc(node) || isInsideImport(node) || ts.isExportSpecifier(node)) return;
    if (ts.isIdentifier(node) && isReference(node)) {
      const symbol = referenceSymbol(node, context.checker);
      const replacement = symbol ? importedSymbols.get(symbol) : undefined;
      if (replacement !== undefined) {
        const text = ts.isShorthandPropertyAssignment(node.parent)
          ? `${node.text}: ${replacement}`
          : isReferenceCallCallee(node)
            ? `(0, ${replacement})`
            : replacement;
        edits.push({ start: node.getStart(context.file), end: node.end, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(context.file);
  return applySourceEdits(source, edits);
}

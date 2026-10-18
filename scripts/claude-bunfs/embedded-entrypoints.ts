import ts from "typescript-legacy";

export interface EmbeddedModuleReference {
  readonly importer: string;
  readonly target: string;
  readonly offset: number;
}

/** Bun workers can be addressed by a path in build metadata rather than an import. */
export function discoverEmbeddedModuleReferences(
  modules: ReadonlyArray<{ readonly name: string; readonly source: string }>,
  javascriptNames: ReadonlySet<string>,
): ReadonlyArray<EmbeddedModuleReference> {
  const references: EmbeddedModuleReference[] = [];
  for (const module of modules) {
    const file = ts.createSourceFile(
      module.name,
      module.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteralLike(node) &&
        javascriptNames.has(node.text) &&
        node.text !== module.name
      ) {
        const parent = node.parent;
        const importSpecifier =
          ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          (ts.isCallExpression(parent) &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(parent.expression) && parent.expression.text === "require") ||
              (ts.isPropertyAccessExpression(parent.expression) &&
                parent.expression.name.text === "require" &&
                ts.isMetaProperty(parent.expression.expression) &&
                parent.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword)));
        if (!importSpecifier)
          references.push({
            importer: module.name,
            target: node.text,
            offset: node.getStart(file),
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return references;
}

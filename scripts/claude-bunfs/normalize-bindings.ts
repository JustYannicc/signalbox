import ts from "typescript-legacy";

interface Scope {
  readonly parent: Scope | undefined;
  readonly functionScope: boolean;
  readonly bindings: Set<string>;
}

/** A rewritten bare require must still resolve to esbuild's host require. */
export function shadowedMetaRequires(file: ts.SourceFile): ReadonlySet<ts.Node> {
  const root: Scope = { parent: undefined, functionScope: true, bindings: new Set() };
  const uses: { node: ts.Node; scope: Scope }[] = [];
  const bind = (name: ts.BindingName, scope: Scope): void => {
    if (ts.isIdentifier(name)) scope.bindings.add(name.text);
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) bind(element.name, scope);
  };
  const visit = (node: ts.Node, scope: Scope): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      scope.bindings.add(node.name.text);
    const functionScope = ts.isFunctionLike(node);
    const ownsScope =
      functionScope ||
      ts.isBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isClassLike(node);
    const current: Scope = ownsScope
      ? { parent: scope, functionScope, bindings: new Set() }
      : scope;
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name)
      current.bindings.add(node.name.text);
    if (ts.isVariableDeclaration(node)) {
      let destination = current;
      if (
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped)
      ) {
        while (!destination.functionScope && destination.parent) destination = destination.parent;
      }
      bind(node.name, destination);
    } else if (ts.isParameter(node)) bind(node.name, current);
    else if (ts.isImportClause(node) && node.name) current.bindings.add(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
      current.bindings.add(node.name.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "require" &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    )
      uses.push({ node, scope: current });
    ts.forEachChild(node, (child) => visit(child, current));
  };
  visit(file, root);
  return new Set(
    uses
      .filter(({ scope }) => {
        let current: Scope | undefined = scope;
        while (current) {
          if (current.bindings.has("require")) return true;
          current = current.parent;
        }
        return false;
      })
      .map(({ node }) => node),
  );
}

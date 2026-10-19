import ts from "typescript-legacy";

export interface ScopedOrigin<T> {
  readonly declaration: ts.Identifier;
  readonly origin: T | undefined;
}

/** Minimal lexical binding lookup for analysis of one already parsed module. */
export class ScopedBindings<T> {
  private readonly scopes = new Map<ts.Node, ts.Node>();
  private readonly parents = new Map<ts.Node, ts.Node | undefined>();
  private readonly declarations = new Map<ts.Node, Map<string, ts.Identifier>>();
  private readonly origins = new WeakMap<ts.Identifier, T>();

  constructor(file: ts.SourceFile) {
    const visit = (node: ts.Node, parentScope?: ts.Node): void => {
      const scope = isScope(node) ? node : (parentScope ?? file);
      if (isScope(node)) this.parents.set(scope, parentScope);
      else if (!this.parents.has(scope)) this.parents.set(scope, parentScope);
      this.scopes.set(node, scope);
      this.declareNode(node, scope, parentScope);
      ts.forEachChild(node, (child) => visit(child, scope));
    };
    visit(file, undefined);
  }

  setOrigin(declaration: ts.Identifier, origin: T): void {
    this.origins.set(declaration, origin);
  }

  lookup(identifier: ts.Identifier): ScopedOrigin<T> | undefined {
    let scope = this.scopes.get(identifier);
    while (scope) {
      const declaration = this.declarations.get(scope)?.get(identifier.text);
      if (declaration) return { declaration, origin: this.origins.get(declaration) };
      scope = this.parents.get(scope);
    }
    return undefined;
  }

  private declareNode(node: ts.Node, scope: ts.Node, parentScope?: ts.Node): void {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) this.recordDeclaration(scope, clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) this.recordDeclaration(scope, bindings.name);
      else if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) this.recordDeclaration(scope, element.name);
    }
    if (ts.isVariableDeclaration(node)) {
      const target =
        node.parent.flags & ts.NodeFlags.BlockScoped ? scope : this.functionScope(scope);
      for (const identifier of bindingIdentifiers(node.name))
        this.recordDeclaration(target, identifier);
    }
    if (ts.isParameter(node))
      for (const identifier of bindingIdentifiers(node.name))
        this.recordDeclaration(scope, identifier);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && parentScope)
      this.recordDeclaration(parentScope, node.name);
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name)
      this.recordDeclaration(scope, node.name);
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name))
        this.recordDeclaration(scope, identifier);
    }
  }

  private functionScope(scope: ts.Node): ts.Node {
    let current: ts.Node | undefined = scope;
    while (current && !isFunctionScope(current)) current = this.parents.get(current);
    return current ?? scope;
  }

  private recordDeclaration(scope: ts.Node, identifier: ts.Identifier): void {
    const names = this.declarations.get(scope) ?? new Map<string, ts.Identifier>();
    // A duplicate var/function declaration keeps the first binding identity.
    if (!names.has(identifier.text)) names.set(identifier.text, identifier);
    this.declarations.set(scope, names);
  }
}

function isFunctionScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isFunctionLike(node);
}

function isScope(node: ts.Node): boolean {
  return (
    isFunctionScope(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isClassLike(node)
  );
}

function bindingIdentifiers(name: ts.BindingName): ReadonlyArray<ts.Identifier> {
  if (ts.isIdentifier(name)) return [name];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
    );
  }
  return [];
}

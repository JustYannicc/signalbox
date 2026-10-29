export interface ClaudeSdkAstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export type ClaudeSdkParentMap = ReadonlyMap<ClaudeSdkAstNode, ClaudeSdkAstNode | undefined>;

function isNode(value: unknown): value is ClaudeSdkAstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "start") === "number" &&
    typeof Reflect.get(value, "end") === "number"
  );
}

function isFunction(node: ClaudeSdkAstNode) {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    node.type,
  );
}

function isScope(node: ClaudeSdkAstNode) {
  return (
    node.type === "Program" ||
    node.type === "BlockStatement" ||
    node.type === "SwitchStatement" ||
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "CatchClause" ||
    node.type === "StaticBlock" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression" ||
    isFunction(node)
  );
}

function addPatternNames(pattern: unknown, names: Set<string>) {
  if (!isNode(pattern)) return;
  if (pattern.type === "Identifier") {
    if (typeof pattern.name === "string") names.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    addPatternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    addPatternNames(pattern.left, names);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    if (Array.isArray(pattern.elements))
      for (const item of pattern.elements) addPatternNames(item, names);
    return;
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    for (const item of pattern.properties) {
      if (!isNode(item)) continue;
      addPatternNames(item.type === "RestElement" ? item.argument : item.value, names);
    }
  }
}

function addStatementNames(statement: unknown, names: Set<string>, includeVar: boolean) {
  if (!isNode(statement)) return;
  if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
    if (statement.kind !== "var" || includeVar)
      for (const declaration of statement.declarations)
        if (isNode(declaration)) addPatternNames(declaration.id, names);
    return;
  }
  if (
    (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
    isNode(statement.id) &&
    statement.id.type === "Identifier" &&
    typeof statement.id.name === "string"
  )
    names.add(statement.id.name);
}

function addVarNames(node: ClaudeSdkAstNode, names: Set<string>) {
  if (node.type === "StaticBlock" || isFunction(node)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var")
    addStatementNames(node, names, true);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) addVarNames(item, names);
    } else if (isNode(value)) {
      addVarNames(value, names);
    }
  }
}

function directlyDeclares(scope: ClaudeSdkAstNode, name: string) {
  const names = new Set<string>();
  if (scope.type === "CatchClause") addPatternNames(scope.param, names);
  if (isFunction(scope)) {
    if (Array.isArray(scope.params))
      for (const parameter of scope.params) addPatternNames(parameter, names);
    if (
      (scope.type === "FunctionExpression" || scope.type === "FunctionDeclaration") &&
      isNode(scope.id) &&
      scope.id.type === "Identifier" &&
      typeof scope.id.name === "string"
    )
      names.add(scope.id.name);
    if (isNode(scope.body)) addVarNames(scope.body, names);
  } else if (scope.type === "ForStatement") {
    if (isNode(scope.init) && scope.init.type === "VariableDeclaration")
      addStatementNames(scope.init, names, false);
  } else if (scope.type === "ForInStatement" || scope.type === "ForOfStatement") {
    if (isNode(scope.left) && scope.left.type === "VariableDeclaration")
      addStatementNames(scope.left, names, false);
  } else if (scope.type === "SwitchStatement") {
    if (Array.isArray(scope.cases))
      for (const item of scope.cases)
        if (isNode(item) && Array.isArray(item.consequent))
          for (const statement of item.consequent) addStatementNames(statement, names, false);
  } else if (scope.type === "StaticBlock") {
    if (Array.isArray(scope.body))
      for (const statement of scope.body) addStatementNames(statement, names, false);
  } else if (scope.type === "BlockStatement" || scope.type === "Program") {
    if (Array.isArray(scope.body))
      for (const statement of scope.body) addStatementNames(statement, names, false);
    if (scope.type === "Program") {
      if (Array.isArray(scope.body))
        for (const statement of scope.body)
          if (
            isNode(statement) &&
            statement.type === "ImportDeclaration" &&
            Array.isArray(statement.specifiers)
          )
            for (const specifier of statement.specifiers)
              if (isNode(specifier)) addPatternNames(specifier.local, names);
      addVarNames(scope, names);
    }
  } else if (scope.type === "ClassDeclaration" || scope.type === "ClassExpression") {
    if (isNode(scope.id) && scope.id.type === "Identifier" && typeof scope.id.name === "string")
      names.add(scope.id.name);
  }
  return names.has(name);
}

function isDescendant(
  node: ClaudeSdkAstNode,
  ancestor: ClaudeSdkAstNode,
  parents: ClaudeSdkParentMap,
) {
  for (let current: ClaudeSdkAstNode | undefined = node; current; current = parents.get(current))
    if (current === ancestor) return true;
  return false;
}

function isBindingIdentifier(node: ClaudeSdkAstNode, parents: ClaudeSdkParentMap) {
  for (let current: ClaudeSdkAstNode | undefined = node; current; current = parents.get(current)) {
    const parent = parents.get(current);
    if (!parent) return false;
    if (
      parent.type === "VariableDeclarator" &&
      isNode(parent.id) &&
      isDescendant(node, parent.id, parents)
    )
      return true;
    if (
      isFunction(parent) &&
      Array.isArray(parent.params) &&
      parent.params.some((parameter) => isNode(parameter) && isDescendant(node, parameter, parents))
    )
      return true;
    if (
      parent.type === "CatchClause" &&
      isNode(parent.param) &&
      isDescendant(node, parent.param, parents)
    )
      return true;
    if (
      (parent.type === "FunctionDeclaration" ||
        parent.type === "FunctionExpression" ||
        parent.type === "ClassDeclaration" ||
        parent.type === "ClassExpression") &&
      isNode(parent.id) &&
      parent.id === node
    )
      return true;
    if (
      (parent.type === "ImportSpecifier" ||
        parent.type === "ImportDefaultSpecifier" ||
        parent.type === "ImportNamespaceSpecifier") &&
      parent.local === node
    )
      return true;
  }
  return false;
}

export function bindingScope(declaration: ClaudeSdkAstNode, parents: ClaudeSdkParentMap) {
  const variable = parents.get(declaration);
  const statement = variable && parents.get(variable);
  const isVar = statement?.type === "VariableDeclaration" && statement.kind === "var";
  for (let current = parents.get(declaration); current; current = parents.get(current)) {
    if (isVar ? isFunction(current) || current.type === "Program" : isScope(current))
      return current;
  }
  return undefined;
}

export function isReferenceToBinding(
  reference: ClaudeSdkAstNode,
  declaration: ClaudeSdkAstNode,
  parents: ClaudeSdkParentMap,
): boolean {
  if (reference.type !== "Identifier" || declaration === reference) return false;
  if (isBindingIdentifier(reference, parents)) return false;
  const name = reference.name;
  const declarationId = Reflect.get(declaration, "id");
  if (
    typeof name !== "string" ||
    !isNode(declarationId) ||
    declarationId.type !== "Identifier" ||
    declarationId.name !== name
  )
    return false;
  const scope = bindingScope(declaration, parents);
  if (!scope || !isDescendant(reference, scope, parents)) return false;
  for (
    let current = parents.get(reference);
    current && current !== scope;
    current = parents.get(current)
  ) {
    if (current.type === "WithStatement")
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_SCOPE_UNSUPPORTED");
    if (isScope(current) && directlyDeclares(current, name)) return false;
  }
  const parent = parents.get(reference);
  const exportDeclaration = parent?.type === "ExportSpecifier" ? parents.get(parent) : undefined;
  if (exportDeclaration?.type === "ExportNamedDeclaration" && exportDeclaration.source !== null)
    return false;
  if (
    (parent?.type === "MemberExpression" &&
      parent.property === reference &&
      parent.computed !== true) ||
    (parent?.type === "Property" &&
      parent.key === reference &&
      parent.computed !== true &&
      parent.shorthand !== true) ||
    ((parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") &&
      parent.key === reference &&
      parent.computed !== true) ||
    ((parent?.type === "LabeledStatement" ||
      parent?.type === "BreakStatement" ||
      parent?.type === "ContinueStatement") &&
      parent.label === reference) ||
    (parent?.type === "MetaProperty" && parent.meta === reference)
  )
    return false;
  return true;
}

import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";

/** Resolve global `require` and aliases while respecting lexical shadowing. */
export type RequireBindings = ScopedBindings<true> & { readonly modules: ScopedBindings<true> };

export function nodeRequireBindings(file: ts.SourceFile, format?: number): RequireBindings {
  if (format !== undefined && format !== 1 && format !== 2)
    throw new Error(`BUN_MODULE_FORMAT_UNSUPPORTED: ${file.fileName}: ${format}`);
  const bindings = Object.assign(new ScopedBindings<true>(file), {
    modules: new ScopedBindings<true>(file),
  });
  if (format === 2) {
    const parameter = commonJsRequireParameter(file);
    bindings.setOrigin(parameter, true);
    const wrapper = parameter.parent.parent;
    const moduleParameter = ts.isFunctionExpression(wrapper)
      ? wrapper.parameters[2]?.name
      : undefined;
    if (moduleParameter && ts.isIdentifier(moduleParameter))
      bindings.modules.setOrigin(moduleParameter, true);
  }
  let declarationCount = 0;
  const countDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarationCount++;
    ts.forEachChild(node, countDeclarations);
  };
  countDeclarations(file);

  for (let pass = 0; pass < declarationCount + 1; pass++) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        node.parent.flags & ts.NodeFlags.Const
      ) {
        const initializer = node.initializer;
        const globalRequire =
          ts.isIdentifier(initializer) &&
          initializer.text === "require" &&
          !bindings.lookup(initializer);
        const inheritedRequire =
          ts.isIdentifier(initializer) && bindings.lookup(initializer)?.origin === true;
        const metaRequire = isRequireMember(initializer, bindings);
        if (
          (globalRequire || inheritedRequire || metaRequire) &&
          bindings.lookup(node.name)?.origin !== true
        ) {
          bindings.setOrigin(node.name, true);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) break;
  }
  return bindings;
}

function commonJsRequireParameter(file: ts.SourceFile): ts.Identifier {
  const statement = file.statements[0];
  if (file.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement))
    throw new Error(`BUN_CJS_SHAPE_CHANGED: ${file.fileName}`);
  let expression = statement.expression;
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression))
    expression = expression.expression;
  if (
    !ts.isFunctionExpression(expression) ||
    expression.name ||
    expression.asteriskToken ||
    expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    expression.parameters.some((parameter) => parameter.dotDotDotToken || parameter.initializer) ||
    expression.parameters.map((parameter) => parameter.name.getText(file)).join(",") !==
      "exports,require,module,__filename,__dirname"
  )
    throw new Error(`BUN_CJS_SHAPE_CHANGED: ${file.fileName}`);
  const parameter = expression.parameters[1]?.name;
  if (!parameter || !ts.isIdentifier(parameter))
    throw new Error(`BUN_CJS_SHAPE_CHANGED: ${file.fileName}`);
  return parameter;
}

export function isNodeRequireCall(call: ts.CallExpression, bindings: RequireBindings): boolean {
  const expression = unwrapRequireExpression(call.expression);
  if (ts.isIdentifier(expression)) {
    const binding = bindings.lookup(expression);
    if (expression.text === "require") return binding ? binding.origin === true : true;
    return binding?.origin === true;
  }
  return isRequireMember(expression, bindings);
}

type FactoryOrigin = "module" | "factory" | "created";

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

export function unwrapRequireExpression(expression: ts.Expression): ts.Expression {
  while (true) {
    if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression))
      expression = expression.expression;
    else if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
      expression = expression.right;
    else return expression;
  }
}

function property(
  expression: ts.Expression,
): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(expression))
    return { receiver: expression.expression, name: expression.name.text };
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return { receiver: expression.expression, name: expression.argumentExpression.text };
  return undefined;
}

function isImportMetaRequire(expression: ts.Expression): boolean {
  const member = property(unwrapRequireExpression(expression));
  return (
    member?.name === "require" &&
    ts.isMetaProperty(member.receiver) &&
    member.receiver.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function isModuleImport(expression: ts.Expression): expression is ts.CallExpression {
  return (
    ts.isCallExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    Boolean(
      expression.arguments[0] &&
      ts.isStringLiteralLike(expression.arguments[0]) &&
      ["module", "node:module"].includes(expression.arguments[0].text),
    )
  );
}

/** Factory calls always remain uncertain: their base URL need not be this module. */
export function factoryRequireEscapes(
  file: ts.SourceFile,
  requires: RequireBindings,
): ReadonlyArray<ts.Node> {
  const bindings = new ScopedBindings<FactoryOrigin>(file);
  const origin = (expression: ts.Expression): FactoryOrigin | undefined => {
    const value = unwrapRequireExpression(expression);
    if (ts.isIdentifier(value)) return bindings.lookup(value)?.origin;
    if (isModuleImport(value)) return "module";
    const member = property(value);
    if (member?.name === "createRequire" && origin(member.receiver) === "module") return "factory";
    if (ts.isCallExpression(value)) {
      if (
        isNodeRequireCall(value, requires) &&
        value.arguments[0] &&
        ts.isStringLiteralLike(value.arguments[0]) &&
        ["module", "node:module"].includes(value.arguments[0].text)
      )
        return "module";
      if (origin(value.expression) === "factory") return "created";
    }
    return undefined;
  };
  let changed = false;
  const assign = (name: ts.BindingName, value: FactoryOrigin): void => {
    if (ts.isIdentifier(name) && bindings.lookup(name)?.origin !== value) {
      bindings.setOrigin(name, value);
      changed = true;
    } else if (ts.isObjectBindingPattern(name) && value === "module")
      for (const element of name.elements) {
        const key = element.propertyName ?? element.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "createRequire")
          assign(element.name, "factory");
      }
  };
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !["module", "node:module"].includes(statement.moduleSpecifier.text) ||
      !statement.importClause
    )
      continue;
    const clause = statement.importClause;
    if (clause.name) assign(clause.name, "module");
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      assign(clause.namedBindings.name, "module");
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements)
        if ((element.propertyName?.text ?? element.name.text) === "createRequire")
          assign(element.name, "factory");
  }
  let count = 0;
  const declarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) count++;
    ts.forEachChild(node, declarations);
  };
  declarations(file);
  for (let pass = 0; pass <= count; pass++) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then" &&
        isModuleImport(unwrapRequireExpression(node.expression.expression))
      ) {
        const callback = node.arguments[0];
        if (callback && ts.isFunctionLike(callback) && callback.parameters[0])
          assign(callback.parameters[0].name, "module");
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const value = origin(node.initializer);
        if (value) assign(node.name, value);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) break;
  }
  const escapes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isModuleImport(node)) {
      let outer: ts.Expression = node;
      while (
        outer.parent &&
        (ts.isParenthesizedExpression(outer.parent) || ts.isAwaitExpression(outer.parent)) &&
        outer.parent.expression === outer
      )
        outer = outer.parent;
      const parent = outer.parent;
      const assigned = ts.isVariableDeclaration(parent) && parent.initializer === outer;
      const receiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === outer;
      const awaitedMember =
        receiver && ts.isAwaitExpression(unwrapParentheses(outer)) && origin(parent) === "factory";
      const inlineThen =
        receiver &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name.text === "then" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        parent.parent.arguments[0] &&
        ts.isFunctionLike(parent.parent.arguments[0]);
      if (!assigned && !awaitedMember && !inlineThen) escapes.push(node);
    }
    if (ts.isCallExpression(node) && origin(node.expression) === "factory") escapes.push(node);
    else if (
      (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      (!ts.isIdentifier(node) || !isDeclarationIdentifier(node))
    ) {
      const value = origin(node);
      const parent = node.parent;
      const receiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      const directFactory =
        ts.isCallExpression(parent) && parent.expression === node && value === "factory";
      if ((value === "factory" || value === "created") && !receiver && !directFactory)
        escapes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return escapes;
}

function isRequireMember(expression: ts.Expression, bindings: RequireBindings): boolean {
  const member = property(unwrapRequireExpression(expression));
  return (
    isImportMetaRequire(expression) ||
    Boolean(
      member?.name === "require" &&
      ts.isIdentifier(member.receiver) &&
      (bindings.modules.lookup(member.receiver)?.origin ||
        (["global", "globalThis"].includes(member.receiver.text) &&
          !bindings.lookup(member.receiver))),
    )
  );
}

function isRequireValue(identifier: ts.Identifier, bindings: ScopedBindings<true>): boolean {
  const binding = bindings.lookup(identifier);
  if (identifier.text === "require") return binding ? binding.origin === true : true;
  return binding?.origin === true;
}

function isConstAlias(expression: ts.Expression): boolean {
  const parent = expression.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isIdentifier(parent.name) &&
    Boolean(parent.parent.flags & ts.NodeFlags.Const)
  );
}

function isDeclarationIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    ts.isBindingElement(parent) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    (ts.isImportClause(parent) && parent.name === identifier) ||
    (ts.isNamespaceImport(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) &&
      (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier)
  );
}

/** Find require-function values used outside a direct call or a plain const alias. */
export function nodeRequireEscapes(
  file: ts.SourceFile,
  bindings: RequireBindings,
): ReadonlyArray<ts.Node> {
  const escapes: ts.Node[] = [];
  const offsets = new Set<number>();
  const add = (node: ts.Node) => {
    const offset = node.getStart(file);
    if (offsets.has(offset)) return;
    offsets.add(offset);
    escapes.push(node);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) && isRequireValue(node, bindings)) {
      const parent = node.parent;
      const directCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        isNodeRequireCall(parent, bindings);
      if (!directCall && !isConstAlias(node)) add(node);
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isRequireMember(node, bindings)
    ) {
      const parent = node.parent;
      const directCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        isNodeRequireCall(parent, bindings);
      if (!directCall && !isConstAlias(node)) add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return escapes;
}

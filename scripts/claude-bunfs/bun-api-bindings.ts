import ts from "typescript-legacy";

export type BunApiAccess = "read" | "call" | "construct";

interface BunApiUseLocation {
  readonly module: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly access: BunApiAccess;
}

export type BunApiUse = BunApiUseLocation &
  (
    | { readonly path: string; readonly basePath?: never }
    | { readonly path?: never; readonly basePath: string }
  );

type BunValue =
  | { readonly kind: "bun" }
  | { readonly kind: "globalThis" }
  | { readonly kind: "uncertainBun" }
  | { readonly kind: "member"; readonly path: ReadonlyArray<string> };

class Scope {
  readonly bindings = new Map<string, BunValue | undefined>();
  readonly parent: Scope | undefined;
  readonly isolatedWrites: boolean;

  constructor(parent?: Scope, isolatedWrites = false) {
    this.parent = parent;
    this.isolatedWrites = isolatedWrites;
  }

  declare(name: string): void {
    if (!this.bindings.has(name)) this.bindings.set(name, undefined);
  }

  set(name: string, value: BunValue | undefined): void {
    // oxlint-disable-next-line typescript/no-this-alias -- Walk lexical parents without recursive calls.
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      if (scope.bindings.has(name)) {
        scope.bindings.set(name, value);
        return;
      }
      if (scope.isolatedWrites && scope.lookup(name).found) {
        scope.bindings.set(name, value);
        return;
      }
    }
  }

  lookup(
    name: string,
  ): { readonly found: true; readonly value: BunValue | undefined } | { readonly found: false } {
    // oxlint-disable-next-line typescript/no-this-alias -- Walk lexical parents without recursive calls.
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      if (scope.bindings.has(name)) return { found: true, value: scope.bindings.get(name) };
    }
    return { found: false };
  }

  fork(): Scope {
    return new Scope(this, true);
  }

  merge(branches: ReadonlyArray<Scope>): void {
    const changedNames = new Set(branches.flatMap((branch) => [...branch.bindings.keys()]));
    for (const name of changedNames) {
      const values = branches.map((branch) => branch.lookup(name));
      this.set(name, mergeValues(values.map((value) => (value.found ? value.value : undefined))));
    }
  }
}

function sameValue(left: BunValue | undefined, right: BunValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  return (
    left.kind !== "member" ||
    (right.kind === "member" &&
      left.path.length === right.path.length &&
      left.path.every((part, index) => part === right.path[index]))
  );
}

function mergeValues(values: ReadonlyArray<BunValue | undefined>): BunValue | undefined {
  const [first] = values;
  if (values.every((value) => sameValue(first, value))) return first;
  // Preserve the chance of Bun without claiming an exact member after paths diverge.
  return values.some(isBunRelated) ? uncertainBunRoot : undefined;
}

function isBunRelated(value: BunValue | undefined): boolean {
  return value?.kind === "bun" || value?.kind === "member" || value?.kind === "uncertainBun";
}

const bunRoot: BunValue = { kind: "bun" };
const globalThisRoot: BunValue = { kind: "globalThis" };
const uncertainBunRoot: BunValue = { kind: "uncertainBun" };

function getParseDiagnostics(sourceFile: ts.SourceFile): ReadonlyArray<ts.Diagnostic> {
  const diagnostics: unknown = Reflect.get(sourceFile, "parseDiagnostics");
  if (!Array.isArray(diagnostics)) {
    throw new TypeError("typescript-legacy SourceFile.parseDiagnostics is unavailable");
  }
  const validated = diagnostics.filter(isDiagnostic);
  if (validated.length !== diagnostics.length) {
    throw new TypeError("typescript-legacy returned an unsupported parse diagnostic");
  }
  return validated;
}

function isDiagnostic(value: unknown): value is ts.Diagnostic {
  if (typeof value !== "object" || value === null) return false;
  const message = Reflect.get(value, "messageText");
  return (
    typeof Reflect.get(value, "category") === "number" &&
    typeof Reflect.get(value, "code") === "number" &&
    (typeof message === "string" || isDiagnosticMessageChain(message))
  );
}

function isDiagnosticMessageChain(value: unknown): value is ts.DiagnosticMessageChain {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "messageText") === "string" &&
    typeof Reflect.get(value, "category") === "number" &&
    typeof Reflect.get(value, "code") === "number"
  );
}

/** Analyze one source module without evaluating it. */
export function findBunApiUses(moduleName: string, source: string): ReadonlyArray<BunApiUse> {
  const file = ts.createSourceFile(
    moduleName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const parseError = getParseDiagnostics(file)[0];
  if (parseError) {
    const point = file.getLineAndCharacterOfPosition(parseError.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(parseError.messageText, "\n");
    throw new SyntaxError(`${moduleName}:${point.line + 1}:${point.character + 1}: ${message}`);
  }
  const uses: BunApiUse[] = [];
  const moduleScope = new Scope();
  predeclare(file.statements, moduleScope);
  collectVarBindings(file, moduleScope);

  const location = (node: ts.Node) => {
    const offset = node.getStart(file);
    const point = file.getLineAndCharacterOfPosition(offset);
    return { module: moduleName, offset, line: point.line + 1, column: point.character + 1 };
  };
  const addMember = (node: ts.Node, path: ReadonlyArray<string>, access: BunApiAccess): void => {
    if (path.length) uses.push({ ...location(node), path: path.join("."), access });
  };
  const addDynamic = (node: ts.Node, base: BunValue, access: BunApiAccess): void => {
    if (isBunRelated(base)) {
      uses.push({
        ...location(node),
        basePath: base.kind === "member" ? base.path.join(".") : "",
        access,
      });
    }
  };
  bindImports(file.statements, moduleScope, (node, path) => addMember(node, path, "read"));

  const valueOf = (node: ts.Expression | undefined, scope: Scope): BunValue | undefined => {
    if (!node) return undefined;
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const binding = scope.lookup(expression.text);
      if (binding.found) return binding.value;
      if (expression.text === "Bun") return bunRoot;
      if (expression.text === "globalThis") return globalThisRoot;
      return undefined;
    }
    if (ts.isCallExpression(expression) && isBunLoader(expression, scope)) return bunRoot;
    if (ts.isAwaitExpression(expression)) return valueOf(expression.expression, scope);
    if (ts.isBinaryExpression(expression) && isShortCircuit(expression.operatorToken.kind)) {
      return mergeValues([valueOf(expression.left, scope), valueOf(expression.right, scope)]);
    }
    if (ts.isConditionalExpression(expression)) {
      return mergeValues([
        valueOf(expression.whenTrue, scope),
        valueOf(expression.whenFalse, scope),
      ]);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = valueOf(expression.expression, scope);
      if (base?.kind === "uncertainBun") return uncertainBunRoot;
      if (base?.kind === "globalThis" && expression.name.text === "Bun") return bunRoot;
      if (base?.kind === "bun") return { kind: "member", path: [expression.name.text] };
      if (base?.kind === "member")
        return { kind: "member", path: [...base.path, expression.name.text] };
      return undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      const base = valueOf(expression.expression, scope);
      const key = staticKey(expression.argumentExpression);
      if (base?.kind === "uncertainBun") return uncertainBunRoot;
      if (base?.kind === "globalThis" && key === "Bun") return bunRoot;
      if (key === undefined) return undefined;
      if (base?.kind === "bun") return { kind: "member", path: [key] };
      if (base?.kind === "member") return { kind: "member", path: [...base.path, key] };
    }
    return undefined;
  };

  const accessKind = (node: ts.Node): BunApiAccess => {
    const outer = outerAccess(node);
    const parent = outer.parent;
    if (parent && ts.isCallExpression(parent) && parent.expression === outer) return "call";
    if (parent && ts.isNewExpression(parent) && parent.expression === outer) return "construct";
    return "read";
  };

  const visitAssignmentTarget = (target: ts.Expression, scope: Scope, readsValue = false): void => {
    target = unwrap(target);
    if (readsValue) {
      const value = valueOf(target, scope);
      if (value?.kind === "member") addMember(target, value.path, "read");
      else if (value && isBunRelated(value)) addDynamic(target, value, "read");
      else if (
        ts.isElementAccessExpression(target) &&
        staticKey(target.argumentExpression) === undefined
      ) {
        const base = valueOf(target.expression, scope);
        if (base && isBunRelated(base)) addDynamic(target, base, "read");
      }
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const base = valueOf(target.expression, scope);
      if (base?.kind === "member") addMember(target.expression, base.path, "read");
      else if (base && isBunRelated(base)) addDynamic(target.expression, base, "read");
      visit(target.expression, scope);
      if (ts.isElementAccessExpression(target) && target.argumentExpression) {
        visit(target.argumentExpression, scope);
      }
    }
  };

  const bindPattern = (pattern: ts.BindingName, base: BunValue | undefined, scope: Scope): void => {
    if (ts.isIdentifier(pattern)) {
      scope.set(pattern.text, base);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          if (base && isBunRelated(base)) addDynamic(element, base, "read");
          bindUnknown(element.name, scope);
          continue;
        }
        if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
          visit(element.propertyName.expression, scope);
        }
        const key = bindingKey(element);
        const next = append(base, key);
        if (key === undefined && base && isBunRelated(base)) {
          addDynamic(element.propertyName ?? element, base, "read");
        } else if (
          next?.kind === "member" &&
          !ts.isObjectBindingPattern(element.name) &&
          !ts.isArrayBindingPattern(element.name)
        ) {
          addMember(element.propertyName ?? element.name, next.path, "read");
        }
        if (element.initializer) visitDefaultInitializer(element.initializer, scope, visit);
        bindPattern(
          element.name,
          element.initializer ? mergeValues([next, valueOf(element.initializer, scope)]) : next,
          scope,
        );
      }
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isOmittedExpression(element)) {
        if (element.initializer) visitDefaultInitializer(element.initializer, scope, visit);
        bindPattern(
          element.name,
          element.initializer
            ? mergeValues([undefined, valueOf(element.initializer, scope)])
            : undefined,
          scope,
        );
      }
    }
    if (base && isBunRelated(base)) addDynamic(pattern, base, "read");
  };

  const bindAssignmentPattern = (
    pattern: ts.Expression,
    base: BunValue | undefined,
    scope: Scope,
  ): void => {
    pattern = unwrap(pattern);
    if (
      ts.isBinaryExpression(pattern) &&
      pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrap(pattern.left);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        visitAssignmentTarget(target, scope);
        visitDefaultInitializer(pattern.right, scope, visit);
        return;
      }
      visitDefaultInitializer(pattern.right, scope, visit);
      bindAssignmentPattern(
        pattern.left,
        mergeValues([base, valueOf(pattern.right, scope)]),
        scope,
      );
    } else if (ts.isIdentifier(pattern)) {
      scope.set(pattern.text, base);
    } else if (ts.isObjectLiteralExpression(pattern)) {
      for (const property of pattern.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const next = append(base, property.name.text);
          if (next?.kind === "member") addMember(property.name, next.path, "read");
          if (property.objectAssignmentInitializer) {
            visitDefaultInitializer(property.objectAssignmentInitializer, scope, visit);
          }
          scope.set(
            property.name.text,
            property.objectAssignmentInitializer
              ? mergeValues([next, valueOf(property.objectAssignmentInitializer, scope)])
              : next,
          );
        } else if (ts.isPropertyAssignment(property)) {
          if (ts.isComputedPropertyName(property.name)) visit(property.name.expression, scope);
          const key = propertyKey(property.name);
          const next = append(base, key);
          if (key === undefined && base && isBunRelated(base)) {
            addDynamic(property.name, base, "read");
          } else if (next?.kind === "member") {
            addMember(property.name, next.path, "read");
          }
          bindAssignmentPattern(property.initializer, next, scope);
        } else if (ts.isSpreadAssignment(property)) {
          if (base && isBunRelated(base)) addDynamic(property, base, "read");
          bindAssignmentPattern(property.expression, undefined, scope);
        }
      }
    } else if (ts.isArrayLiteralExpression(pattern)) {
      if (base && isBunRelated(base)) addDynamic(pattern, base, "read");
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        bindAssignmentPattern(
          ts.isSpreadElement(element) ? element.expression : element,
          undefined,
          scope,
        );
      }
    } else {
      visitAssignmentTarget(pattern, scope);
    }
  };

  const visitStatements = (statements: ts.NodeArray<ts.Statement>, scope: Scope): void => {
    for (const statement of statements) visit(statement, scope);
  };

  const visit = (node: ts.Node, scope: Scope): void => {
    if (isFunctionLike(node)) {
      const local = new Scope(scope, true);
      if (ts.isFunctionExpression(node) && node.name) local.declare(node.name.text);
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression, scope);
      for (const parameter of node.parameters) bindUnknown(parameter.name, local);
      collectVarBindings(node.body, local);
      for (const parameter of node.parameters) {
        if (parameter.initializer) visitDefaultInitializer(parameter.initializer, local, visit);
        bindPattern(
          parameter.name,
          parameter.initializer
            ? mergeValues([undefined, valueOf(parameter.initializer, local)])
            : undefined,
          local,
        );
      }
      if (node.body) visit(node.body, local);
      return;
    }
    if (ts.isClassLike(node)) {
      const local = new Scope(scope);
      if (ts.isClassExpression(node) && node.name) local.declare(node.name.text);
      ts.forEachChild(node, (child) => visit(child, local));
      return;
    }
    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      const local = new Scope(scope);
      predeclare(node.statements, local);
      visitStatements(node.statements, local);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (!node.initializer) {
        if (!ts.isIdentifier(node.name)) bindPattern(node.name, undefined, scope);
        return;
      }
      visit(node.initializer, scope);
      const value = valueOf(node.initializer, scope);
      if (ts.isIdentifier(node.name)) scope.set(node.name.text, value);
      else {
        if (value?.kind === "member") addMember(node.initializer, value.path, "read");
        bindPattern(node.name, value, scope);
      }
      return;
    }
    if (ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind)) {
      visit(node.left, scope);
      const evaluated = scope.fork();
      const skipped = scope.fork();
      visit(node.right, evaluated);
      scope.merge([evaluated, skipped]);
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      const target = unwrap(node.left);
      const destructuring =
        ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target);
      if (destructuring) visit(node.right, scope);
      const patternValue = destructuring ? valueOf(node.right, scope) : undefined;
      if (!destructuring) {
        visitAssignmentTarget(
          node.left,
          scope,
          node.operatorToken.kind !== ts.SyntaxKind.EqualsToken,
        );
      }
      if (!destructuring && isLogicalAssignment(node.operatorToken.kind)) {
        const evaluated = scope.fork();
        const skipped = scope.fork();
        visit(node.right, evaluated);
        if (ts.isIdentifier(target)) evaluated.set(target.text, valueOf(node.right, evaluated));
        scope.merge([evaluated, skipped]);
        return;
      }
      if (!destructuring) visit(node.right, scope);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const value = destructuring ? patternValue : valueOf(node.right, scope);
        if (value?.kind === "member" && destructuring) {
          addMember(node.right, value.path, "read");
        }
        if (destructuring) bindAssignmentPattern(node.left, value, scope);
        else if (ts.isIdentifier(target)) scope.set(target.text, value);
      }
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      isUpdate(node.operator)
    ) {
      visitAssignmentTarget(node.operand, scope, true);
      return;
    }
    if (ts.isIfStatement(node)) {
      visit(node.expression, scope);
      const thenScope = scope.fork();
      const elseScope = scope.fork();
      visit(node.thenStatement, thenScope);
      if (node.elseStatement) visit(node.elseStatement, elseScope);
      scope.merge([thenScope, elseScope]);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, scope);
      const trueScope = scope.fork();
      const falseScope = scope.fork();
      visit(node.whenTrue, trueScope);
      visit(node.whenFalse, falseScope);
      scope.merge([trueScope, falseScope]);
      return;
    }
    if (ts.isCatchClause(node)) {
      const local = new Scope(scope);
      if (node.variableDeclaration) bindUnknown(node.variableDeclaration.name, local);
      visit(node.block, local);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const writes = scope.fork();
      const loop = new Scope(writes);
      if (
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.flags & ts.NodeFlags.BlockScoped
      ) {
        bindUnknownList(node.initializer, loop);
      }
      if (!ts.isForStatement(node)) visit(node.expression, loop);
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        visit(node.initializer, loop);
        if (!ts.isForStatement(node)) {
          for (const declaration of node.initializer.declarations) {
            if (ts.isIdentifier(declaration.name)) loop.set(declaration.name.text, undefined);
          }
        }
      } else if (node.initializer) {
        if (ts.isForStatement(node)) visit(node.initializer, loop);
        else {
          bindAssignmentPattern(node.initializer, undefined, loop);
        }
      }
      if (ts.isForStatement(node) && node.condition) visit(node.condition, loop);
      if (ts.isForStatement(node) && node.incrementor) visit(node.incrementor, loop);
      visit(node.statement, loop);
      scope.merge([writes, scope.fork()]);
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const loop = scope.fork();
      if (ts.isDoStatement(node)) visit(node.statement, loop);
      visit(node.expression, loop);
      if (ts.isWhileStatement(node)) visit(node.statement, loop);
      scope.merge([loop, scope.fork()]);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isNestedAccess(node) && !isWriteTarget(node) && !isDestructuringBase(node)) {
        const value = valueOf(node, scope);
        if (value?.kind === "member") addMember(node, value.path, accessKind(node));
        else if (value?.kind === "uncertainBun" && !hasDynamicElement(node))
          addDynamic(node, bunRoot, accessKind(node));
        else if (value?.kind === "bun" && isEscapingBunRoot(node))
          addDynamic(node, bunRoot, accessKind(node));
      }
      if (
        ts.isElementAccessExpression(node) &&
        staticKey(node.argumentExpression) === undefined &&
        !isWriteTarget(node)
      ) {
        const base = valueOf(node.expression, scope);
        if (base?.kind === "bun" || base?.kind === "member")
          addDynamic(node, base, accessKind(node));
        else if (base?.kind === "uncertainBun") addDynamic(node, bunRoot, accessKind(node));
      }
    }
    if (
      ts.isIdentifier(node) &&
      isReference(node) &&
      !isNestedAccess(node) &&
      !isWriteTarget(node)
    ) {
      const value = valueOf(node, scope);
      if (value?.kind === "member") addMember(node, value.path, accessKind(node));
      else if (value?.kind === "uncertainBun") addDynamic(node, bunRoot, accessKind(node));
      else if (value?.kind === "bun" && isEscapingBunRoot(node))
        addDynamic(node, bunRoot, accessKind(node));
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };

  visitStatements(file.statements, moduleScope);
  return uses;
}

function bindImports(
  statements: ts.NodeArray<ts.Statement>,
  scope: Scope,
  addMember: (node: ts.Node, path: ReadonlyArray<string>) => void,
): void {
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    if (statement.moduleSpecifier.text !== "bun" || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) scope.set(clause.name.text, bunRoot);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      scope.set(clause.namedBindings.name.text, bunRoot);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        const value =
          imported === "Bun" || imported === "default"
            ? bunRoot
            : ({ kind: "member", path: [imported] } satisfies BunValue);
        scope.set(specifier.name.text, value);
        if (value.kind === "member") addMember(specifier, value.path);
      }
    }
  }
}

function predeclare(statements: ts.NodeArray<ts.Statement>, scope: Scope): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.flags & ts.NodeFlags.BlockScoped)
        bindUnknownList(statement.declarationList, scope);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      scope.declare(statement.name.text);
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) scope.declare(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        scope.declare(clause.namedBindings.name.text);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) scope.declare(specifier.name.text);
      }
    }
  }
}

function collectVarBindings(node: ts.Node | undefined, scope: Scope): void {
  if (!node || isFunctionLike(node) || ts.isClassLike(node)) return;
  if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
    bindUnknownList(node, scope);
  }
  ts.forEachChild(node, (child) => collectVarBindings(child, scope));
}

function bindUnknownList(list: ts.VariableDeclarationList, scope: Scope): void {
  for (const declaration of list.declarations) bindUnknown(declaration.name, scope);
}

function bindUnknown(pattern: ts.BindingName, scope: Scope): void {
  if (ts.isIdentifier(pattern)) scope.declare(pattern.text);
  else
    for (const element of pattern.elements) {
      if (!ts.isOmittedExpression(element)) bindUnknown(element.name, scope);
    }
}

function isBunLoader(node: ts.CallExpression, scope: Scope): boolean {
  const argument = node.arguments[0];
  if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) return false;
  const specifier = argument.text;
  if (specifier !== "bun") return false;
  return (
    (ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      !scope.lookup("require").found) ||
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

function append(base: BunValue | undefined, key: string | undefined): BunValue | undefined {
  if (key === undefined) return undefined;
  if (base?.kind === "globalThis" && key === "Bun") return bunRoot;
  if (base?.kind === "bun") return { kind: "member", path: [key] };
  if (base?.kind === "uncertainBun") return uncertainBunRoot;
  if (base?.kind === "member") return { kind: "member", path: [...base.path, key] };
  return undefined;
}

function bindingKey(element: ts.BindingElement): string | undefined {
  return element.propertyName
    ? propertyKey(element.propertyName)
    : ts.isIdentifier(element.name)
      ? element.name.text
      : undefined;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function staticKey(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isPartiallyEmittedExpression(node)
  )
    node = node.expression;
  return node;
}

function outerAccess(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (isTransparent(parent, current)) current = parent;
    else if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    )
      current = parent;
    else break;
  }
  return current;
}

function isNestedAccess(node: ts.Node): boolean {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (isTransparent(parent, current)) current = parent;
    else if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    )
      return true;
    else return false;
  }
  return false;
}

function visitDefaultInitializer(
  initializer: ts.Expression,
  scope: Scope,
  visit: (node: ts.Node, scope: Scope) => void,
): void {
  const evaluated = scope.fork();
  visit(initializer, evaluated);
  scope.merge([evaluated, scope.fork()]);
}

function isTransparent(parent: ts.Node, child: ts.Node): boolean {
  return (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isPartiallyEmittedExpression(parent)) &&
    parent.expression === child
  );
}

function isWriteTarget(node: ts.Node): boolean {
  let current = node;
  while (current.parent && isTransparent(current.parent, current)) current = current.parent;
  const parent = current.parent;
  return Boolean(
    (parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      isAssignment(parent.operatorToken.kind)) ||
    (parent &&
      ts.isPrefixUnaryExpression(parent) &&
      parent.operand === current &&
      isUpdate(parent.operator)) ||
    (parent &&
      ts.isPostfixUnaryExpression(parent) &&
      parent.operand === current &&
      isUpdate(parent.operator)),
  );
}

function isDestructuringBase(node: ts.Node): boolean {
  const outer = outerAccess(node);
  const parent = outer.parent;
  return Boolean(
    (parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === outer &&
      (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))) ||
    (parent &&
      ts.isBinaryExpression(parent) &&
      parent.right === outer &&
      (ts.isObjectLiteralExpression(parent.left) || ts.isArrayLiteralExpression(parent.left))),
  );
}

function isEscapingBunRoot(node: ts.Node): boolean {
  let expression = node;
  while (expression.parent) {
    const parent = expression.parent;
    if (isTransparent(parent, expression)) expression = parent;
    else if (
      (ts.isBinaryExpression(parent) &&
        isShortCircuit(parent.operatorToken.kind) &&
        (parent.left === expression || parent.right === expression)) ||
      (ts.isConditionalExpression(parent) &&
        (parent.whenTrue === expression || parent.whenFalse === expression)) ||
      (ts.isAwaitExpression(parent) && parent.expression === expression)
    ) {
      expression = parent;
    } else break;
  }

  const parent = expression.parent;
  if (parent && ts.isTypeOfExpression(parent) && parent.expression === expression) return false;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === expression) return false;
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === expression &&
    isAliasBindingTarget(parent.left) &&
    isStandaloneAssignment(parent)
  ) {
    return false;
  }
  return true;
}

function isAliasBindingTarget(target: ts.Expression): boolean {
  target = unwrap(target);
  return (
    ts.isIdentifier(target) ||
    ts.isObjectLiteralExpression(target) ||
    ts.isArrayLiteralExpression(target)
  );
}

function isStandaloneAssignment(assignment: ts.BinaryExpression): boolean {
  let expression: ts.Node = assignment;
  while (expression.parent && isTransparent(expression.parent, expression)) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return Boolean(
    (parent && ts.isExpressionStatement(parent) && parent.expression === expression) ||
    (parent && ts.isForStatement(parent) && parent.initializer === expression),
  );
}

function hasDynamicElement(node: ts.Node): boolean {
  if (!ts.isExpression(node)) return false;
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (
      ts.isElementAccessExpression(current) &&
      staticKey(current.argumentExpression) === undefined
    ) {
      return true;
    }
    current = unwrap(current.expression);
  }
  return false;
}

function isAssignment(operator: ts.SyntaxKind): boolean {
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

function isLogicalAssignment(operator: ts.SyntaxKind): boolean {
  return (
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );
}

function isShortCircuit(operator: ts.SyntaxKind): boolean {
  return (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken
  );
}

function isUpdate(operator: ts.SyntaxKind): boolean {
  return operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignment(parent.operatorToken.kind)) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === node &&
      isUpdate(parent.operator))
  )
    return false;
  return true;
}

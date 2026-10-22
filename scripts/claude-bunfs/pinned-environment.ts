import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";

type Origin = readonly string[];
type Parsed = { file: ts.SourceFile; bindings: ScopedBindings<never> };

export function pinnedEnvironmentSourceId(namespace: string, path: string) {
  return `${namespace}\0${path}`;
}

export function parsePinnedEnvironmentSourceId(value: string) {
  const separator = value.indexOf("\0");
  return separator < 0
    ? { namespace: "bun-graph", path: value }
    : { namespace: value.slice(0, separator), path: value.slice(separator + 1) };
}

function isAssignment(kind: ts.SyntaxKind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isWriteTarget(node: ts.Node, target: ts.Node): boolean {
  if (node === target) return true;
  if (ts.isParenthesizedExpression(target)) return isWriteTarget(node, target.expression);
  if (ts.isPropertyAccessExpression(target)) return isWriteTarget(node, target.expression);
  if (ts.isElementAccessExpression(target)) return isWriteTarget(node, target.expression);
  if (ts.isArrayLiteralExpression(target))
    return target.elements.some((element) => isWriteTarget(node, element));
  if (ts.isObjectLiteralExpression(target))
    return target.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) return isWriteTarget(node, property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return node === property.name;
      if (ts.isSpreadAssignment(property)) return isWriteTarget(node, property.expression);
      return false;
    });
  return false;
}

function isWrite(node: ts.Node): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && isAssignment(parent.operatorToken.kind))
      return isWriteTarget(node, parent.left);
    if (ts.isDeleteExpression(parent)) return isWriteTarget(node, parent.expression);
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return isWriteTarget(node, parent.operand);
    if (
      (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
      !ts.isVariableDeclarationList(parent.initializer)
    )
      return isWriteTarget(node, parent.initializer);
  }
  return false;
}

// `process` is also reachable as a property of the global object, so an unresolved global
// counts as a possible route to `process.env`.
const GLOBAL_OBJECT = "#global";
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "self", "window"]);
const hasEnvironmentOrigin = (origin: Origin | undefined) => origin?.[0] === "env";
const canReachEnvironment = (origin: Origin | undefined) =>
  origin !== undefined &&
  (origin.length === 0 ||
    origin[0] === "?" ||
    origin[0] === GLOBAL_OBJECT ||
    hasEnvironmentOrigin(origin));

function isImportMetaRequire(node: ts.Node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "require" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  );
}

function processRequireOrigin(node: ts.Node, module: Parsed): Origin | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
  const callee = node.expression;
  const isRequire =
    isImportMetaRequire(callee) ||
    (ts.isIdentifier(callee) &&
      callee.text === "require" &&
      module.bindings.lookup(callee) === undefined) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "require" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "module" &&
      module.bindings.lookup(callee.expression) === undefined);
  if (!isRequire) return undefined;
  const argument = node.arguments[0];
  if (!argument || !ts.isStringLiteralLike(argument)) return ["?"];
  return argument.text === "process" || argument.text === "node:process" ? [] : undefined;
}

function bindingPath(declaration: ts.Identifier, variable: ts.VariableDeclaration) {
  if (ts.isIdentifier(variable.name)) return [];
  const path: string[] = [];
  let current: ts.Node = declaration;
  while (current !== variable.name) {
    const parent = current.parent;
    if (ts.isBindingElement(parent)) {
      if (parent.dotDotDotToken) return undefined;
      const key = parent.propertyName
        ? ts.isStringLiteralLike(parent.propertyName) || ts.isNumericLiteral(parent.propertyName)
          ? parent.propertyName.text
          : "?"
        : ts.isIdentifier(parent.name)
          ? parent.name.text
          : "?";
      path.unshift(key);
      current = parent;
      continue;
    }
    if (ts.isObjectBindingPattern(parent) || ts.isArrayBindingPattern(parent)) {
      current = parent;
      continue;
    }
    return undefined;
  }
  return path;
}

/** Resolve imported env aliases before esbuild folds guards. Imported bindings are invisible to define. */
export function createPinnedEnvironmentTransform(
  sources: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | null>>,
  resolve: (specifier: string, importer: string) => string | undefined,
) {
  const sourceByName = new Map(sources);
  const parsed = new Map<string, Parsed>();
  const hits = new Map<string, number>();
  let mutations = new WeakMap<ts.Identifier, boolean>();
  let cacheParsed = true;
  let analyzed = false;
  let invalidateAllPins = false;
  const assignmentValues = new Map<ts.Identifier, ts.Expression[]>();
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const properties = Object.keys(env).map(
    (key) =>
      `(?:\\.\\s*${escaped(key)}(?![\\w$])|\\[\\s*(?:${escaped(JSON.stringify(key))}|${escaped(`'${key}'`)})\\s*\\])`,
  );
  const hasPinnedProperty = properties.length ? new RegExp(properties.join("|")) : undefined;
  const parse = (name: string, source?: string) => {
    const previous = parsed.get(name);
    if (previous && (source === undefined || previous.file.text === source)) return previous;
    const text = source ?? sourceByName.get(name);
    if (text === undefined) return undefined;
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const value = { file, bindings: new ScopedBindings<never>(file) };
    if (cacheParsed) parsed.set(name, value);
    return value;
  };
  const addSource = (name: string, source: string) => {
    const previous = sourceByName.get(name);
    if (previous === source) return;
    if (analyzed) {
      invalidateAllPins = true;
      throw new Error(`RELEASE_OMISSION_GRAPH_CHANGED: ${name}`);
    }
    parsed.delete(name);
    sourceByName.set(name, source);
  };
  const property = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
  const importTarget = (specifier: string, importer: string) =>
    specifier === "process" || specifier === "node:process"
      ? specifier
      : resolve(specifier, importer);

  function exported(
    name: string,
    member: string,
    seen: Set<ts.Node>,
    allowMutableAliases: boolean,
  ): Origin | undefined {
    if (name === "process" || name === "node:process")
      return member === "env" ? ["env"] : member === "default" || member === "*" ? [] : undefined;
    const module = parse(name);
    if (!module) return undefined;
    for (const statement of module.file.statements) {
      if (seen.has(statement)) continue;
      const next = new Set(seen).add(statement);
      if (ts.isExportDeclaration(statement)) {
        const target =
          statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? importTarget(statement.moduleSpecifier.text, name)
            : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const item = statement.exportClause.elements.find((item) => item.name.text === member);
          if (item)
            return target
              ? exported(target, (item.propertyName ?? item.name).text, next, allowMutableAliases)
              : origin(item.propertyName ?? item.name, module, next, allowMutableAliases);
        } else if (target && !statement.exportClause) {
          const value = exported(target, member, next, allowMutableAliases);
          if (value) return value;
        }
      }
      if (ts.isExportAssignment(statement) && member === "default")
        return origin(statement.expression, module, next, allowMutableAliases);
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === member,
        );
        if (declaration && ts.isIdentifier(declaration.name)) {
          const candidates = [
            ...(declaration.initializer ? [declaration.initializer] : []),
            ...(allowMutableAliases ? (assignmentValues.get(declaration.name) ?? []) : []),
          ];
          let processOrigin: Origin | undefined;
          for (const candidate of candidates) {
            const value = origin(candidate, module, next, allowMutableAliases);
            if (!allowMutableAliases && value !== undefined) return value;
            if (hasEnvironmentOrigin(value)) return value;
            if (canReachEnvironment(value)) processOrigin = value;
          }
          if (processOrigin) return processOrigin;
        }
      }
    }
    return undefined;
  }

  function origin(
    node: ts.Node,
    module: Parsed,
    seen = new Set<ts.Node>(),
    allowMutableAliases = false,
  ): Origin | undefined {
    if (seen.has(node)) return undefined;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node))
      return origin(node.expression, module, seen, allowMutableAliases);
    const requireOrigin = processRequireOrigin(node, module);
    if (requireOrigin !== undefined) return requireOrigin;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = origin(node.expression, module, seen, allowMutableAliases);
      const key = property(node);
      if (base?.length === 1 && base[0] === GLOBAL_OBJECT) {
        if (key === "process") return [];
        // A computed key on the global object may name `process`.
        return key === undefined ? ["?"] : undefined;
      }
      if (base) return [...base, key ?? "?"];
      if (key !== undefined && ts.isIdentifier(node.expression)) {
        const target = namespaceTarget(node.expression, module);
        if (target) return exported(target, key, seen, allowMutableAliases);
      }
      return undefined;
    }
    if (!ts.isIdentifier(node)) return undefined;
    const binding = module.bindings.lookup(node);
    if (!binding)
      return node.text === "process"
        ? []
        : GLOBAL_OBJECT_NAMES.has(node.text)
          ? [GLOBAL_OBJECT]
          : undefined;
    const declaration = binding.declaration;
    if (seen.has(declaration)) return undefined;
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent)) {
      const path = bindingPath(declaration, parent);
      if (!path) return undefined;
      if (allowMutableAliases) {
        const candidates = [
          ...(parent.initializer ? [parent.initializer] : []),
          ...(assignmentValues.get(declaration) ?? []),
        ];
        let processOrigin: Origin | undefined;
        for (const candidate of candidates) {
          const value = origin(candidate, module, new Set(seen).add(declaration), true);
          const resolved = value === undefined ? undefined : [...value, ...path];
          if (hasEnvironmentOrigin(resolved)) return resolved;
          if (canReachEnvironment(resolved)) processOrigin = resolved;
        }
        return processOrigin;
      }
      if (!parent.initializer) return undefined;
      // Mutable aliases are left for runtime, even when their initial value is known.
      let mutated = mutations.get(declaration) ?? false;
      const visit = (use: ts.Node): void => {
        if (ts.isIdentifier(use) && module.bindings.lookup(use)?.declaration === declaration) {
          if (isWrite(use)) mutated = true;
        }
        if (!mutated) ts.forEachChild(use, visit);
      };
      if (!mutations.has(declaration)) {
        visit(module.file);
        mutations.set(declaration, mutated);
      }
      if (mutated) return undefined;
      const value = origin(parent.initializer, module, seen.add(declaration));
      return value === undefined ? undefined : [...value, ...path];
    }
    let imported: ts.Node = parent;
    while (imported.parent && !ts.isImportDeclaration(imported)) imported = imported.parent;
    if (!ts.isImportDeclaration(imported) || !ts.isStringLiteralLike(imported.moduleSpecifier))
      return undefined;
    const specifier = imported.moduleSpecifier.text;
    const target = importTarget(specifier, module.file.fileName);
    if (!target) return undefined;
    const member = ts.isImportSpecifier(parent)
      ? (parent.propertyName ?? parent.name).text
      : ts.isNamespaceImport(parent)
        ? "*"
        : "default";
    return exported(target, member, seen.add(declaration), allowMutableAliases);
  }

  function namespaceTarget(node: ts.Identifier, module: Parsed) {
    const binding = module.bindings.lookup(node);
    if (!binding || !ts.isNamespaceImport(binding.declaration.parent)) return undefined;
    let imported: ts.Node = binding.declaration.parent;
    while (imported.parent && !ts.isImportDeclaration(imported)) imported = imported.parent;
    if (!ts.isImportDeclaration(imported) || !ts.isStringLiteralLike(imported.moduleSpecifier))
      return undefined;
    const specifier = imported.moduleSpecifier.text;
    return specifier === "process" || specifier === "node:process"
      ? specifier
      : importTarget(specifier, module.file.fileName);
  }

  const possibleOrigin = (node: ts.Node, module: Parsed) => origin(node, module, new Set(), true);

  const analyze = () => {
    if (analyzed) return;
    analyzed = true;
    if (!hasPinnedProperty) return;
    const modules: { readonly name: string; readonly parsed: Parsed }[] = [];
    for (const [name, source] of sourceByName) {
      const parsedSource = parse(name, source);
      if (parsedSource) modules.push({ name, parsed: parsedSource });
    }
    for (const { parsed: module } of modules) {
      const collectAssignments = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          isAssignment(node.operatorToken.kind) &&
          ts.isIdentifier(node.left)
        ) {
          const declaration = module.bindings.lookup(node.left)?.declaration;
          if (declaration) {
            const values = assignmentValues.get(declaration) ?? [];
            values.push(node.right);
            assignmentValues.set(declaration, values);
          }
        }
        ts.forEachChild(node, collectAssignments);
      };
      collectAssignments(module.file);
    }
    const mutable = (declaration: ts.Identifier) => {
      const variable = declaration.parent;
      return (
        ts.isVariableDeclaration(variable) &&
        ts.isVariableDeclarationList(variable.parent) &&
        (variable.parent.flags & ts.NodeFlags.Const) === 0
      );
    };
    const exportedMutableEnvironment = (statement: ts.VariableStatement, module: Parsed) => {
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
        return false;
      return statement.declarationList.declarations.some((declaration) => {
        if (!ts.isIdentifier(declaration.name) || !mutable(declaration.name)) return false;
        const candidates = [
          ...(declaration.initializer ? [declaration.initializer] : []),
          ...(assignmentValues.get(declaration.name) ?? []),
        ];
        return candidates.some((candidate) =>
          canReachEnvironment(possibleOrigin(candidate, module)),
        );
      });
    };
    const presenceCheck = (node: ts.Node, module: Parsed) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        hasEnvironmentOrigin(possibleOrigin(node.right, module))
      )
        return true;
      if (!ts.isCallExpression(node)) return false;
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "hasOwn" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object"
      )
        return (
          node.arguments[0] !== undefined &&
          hasEnvironmentOrigin(possibleOrigin(node.arguments[0], module))
        );
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "hasOwnProperty" &&
        hasEnvironmentOrigin(possibleOrigin(callee.expression, module))
      )
        return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "call" &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "hasOwnProperty"
      )
        return (
          node.arguments[0] !== undefined &&
          hasEnvironmentOrigin(possibleOrigin(node.arguments[0], module))
        );
      return false;
    };
    const escapesEnvironment = (node: ts.Node, module: Parsed) => {
      const possible = possibleOrigin(node, module);
      if (!canReachEnvironment(possible) || ((possible?.length ?? 2) > 1 && possible?.[0] !== "?"))
        return false;
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        return parent.expression !== node;
      if (ts.isVariableDeclaration(parent)) {
        if (parent.name === node) return false;
        if (!ts.isIdentifier(parent.name)) return true;
        return false;
      }
      if (ts.isExportSpecifier(parent)) {
        const binding = ts.isIdentifier(node) ? module.bindings.lookup(node) : undefined;
        return binding !== undefined && mutable(binding.declaration);
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.right === node &&
        isAssignment(parent.operatorToken.kind) &&
        ts.isIdentifier(parent.left)
      )
        return module.bindings.lookup(parent.left) === undefined;
      return true;
    };
    for (const { parsed: module } of modules) {
      const visit = (node: ts.Node): void => {
        if (ts.isVariableStatement(node) && exportedMutableEnvironment(node, module))
          invalidateAllPins = true;
        if (isWrite(node) && canReachEnvironment(possibleOrigin(node, module)))
          invalidateAllPins = true;
        if (presenceCheck(node, module) || escapesEnvironment(node, module))
          invalidateAllPins = true;
        ts.forEachChild(node, visit);
      };
      visit(module.file);
    }
    assignmentValues.clear();
  };
  const transform = (source: string, name: string) => {
    if (!hasPinnedProperty) return source;
    analyze();
    if (invalidateAllPins || !hasPinnedProperty?.test(source)) return source;
    const module = parse(name, source);
    if (!module) return source;
    const edits: { start: number; end: number; value: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = property(node);
        if (key !== undefined && Object.hasOwn(env, key)) {
          const base = origin(node.expression, module);
          const written = isWrite(node);
          if (base?.join(".") === "env" && !written) {
            edits.push({
              start: node.getStart(module.file),
              end: node.end,
              value: env[key] === null ? "void 0" : JSON.stringify(env[key]),
            });
            hits.set(key, (hits.get(key) ?? 0) + 1);
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.file);
    for (const edit of edits.toReversed())
      source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    return source;
  };
  return {
    analyze,
    addSource,
    transform,
    dropParseCache: () => {
      parsed.clear();
      mutations = new WeakMap();
      cacheParsed = false;
    },
    report: () => Object.fromEntries([...hits].sort(([a], [b]) => a.localeCompare(b))),
  };
}

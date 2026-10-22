import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";

type Origin = readonly string[];
type Parsed = { file: ts.SourceFile; bindings: ScopedBindings<never> };

/** Resolve imported env aliases before esbuild folds guards. Imported bindings are invisible to define. */
export function createPinnedEnvironmentTransform(
  sources: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | null>>,
  resolve: (specifier: string, importer: string) => string | undefined,
) {
  const parsed = new Map<string, Parsed>();
  const hits = new Map<string, number>();
  const mutations = new WeakMap<ts.Identifier, boolean>();
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const properties = Object.keys(env).map(
    (key) =>
      `(?:\\.\\s*${escaped(key)}(?![\\w$])|\\[\\s*(?:${escaped(JSON.stringify(key))}|${escaped(`'${key}'`)})\\s*\\])`,
  );
  const hasPinnedProperty = properties.length ? new RegExp(properties.join("|")) : undefined;
  const parse = (name: string, source?: string) => {
    const previous = parsed.get(name);
    if (previous && (source === undefined || previous.file.text === source)) return previous;
    const text = source ?? sources.get(name);
    if (text === undefined) return undefined;
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const value = { file, bindings: new ScopedBindings<never>(file) };
    parsed.set(name, value);
    return value;
  };
  const property = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
  const exported = (name: string, member: string, seen: Set<ts.Node>): Origin | undefined => {
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
            ? resolve(statement.moduleSpecifier.text, name)
            : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const item = statement.exportClause.elements.find((item) => item.name.text === member);
          if (item)
            return target
              ? exported(target, (item.propertyName ?? item.name).text, next)
              : origin(item.propertyName ?? item.name, module, next);
        } else if (target && !statement.exportClause) {
          const value = exported(target, member, next);
          if (value) return value;
        }
      }
      if (ts.isExportAssignment(statement) && member === "default")
        return origin(statement.expression, module, next);
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === member,
        );
        if (declaration?.initializer) return origin(declaration.initializer, module, next);
      }
    }
    return undefined;
  };
  const origin = (node: ts.Node, module: Parsed, seen = new Set<ts.Node>()): Origin | undefined => {
    if (seen.has(node)) return undefined;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node)) return origin(node.expression, module, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = origin(node.expression, module, seen);
      const key = property(node);
      return base && key !== undefined ? [...base, key] : undefined;
    }
    if (!ts.isIdentifier(node)) return undefined;
    const binding = module.bindings.lookup(node);
    if (!binding) return node.text === "process" ? [] : undefined;
    const declaration = binding.declaration;
    if (seen.has(declaration)) return undefined;
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer) {
      // Mutable aliases are left for runtime, even when their initial value is known.
      let mutated = mutations.get(declaration) ?? false;
      const visit = (use: ts.Node): void => {
        if (ts.isIdentifier(use) && module.bindings.lookup(use)?.declaration === declaration) {
          const p = use.parent;
          if (
            (ts.isBinaryExpression(p) &&
              p.left === use &&
              p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
              (p.operator === ts.SyntaxKind.PlusPlusToken ||
                p.operator === ts.SyntaxKind.MinusMinusToken))
          )
            mutated = true;
        }
        if (!mutated) ts.forEachChild(use, visit);
      };
      if (!mutations.has(declaration)) {
        visit(module.file);
        mutations.set(declaration, mutated);
      }
      return mutated ? undefined : origin(parent.initializer, module, seen.add(declaration));
    }
    let imported: ts.Node = parent;
    while (imported.parent && !ts.isImportDeclaration(imported)) imported = imported.parent;
    if (!ts.isImportDeclaration(imported) || !ts.isStringLiteralLike(imported.moduleSpecifier))
      return undefined;
    const specifier = imported.moduleSpecifier.text;
    const target =
      specifier === "process" || specifier === "node:process"
        ? specifier
        : resolve(specifier, module.file.fileName);
    if (!target) return undefined;
    const member = ts.isImportSpecifier(parent)
      ? (parent.propertyName ?? parent.name).text
      : ts.isNamespaceImport(parent)
        ? "*"
        : "default";
    return exported(target, member, seen.add(declaration));
  };
  const transform = (source: string, name: string) => {
    if (!hasPinnedProperty?.test(source)) return source;
    const module = parse(name, source)!;
    const edits: { start: number; end: number; value: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = property(node);
        if (key !== undefined && Object.hasOwn(env, key)) {
          const base = origin(node.expression, module);
          const parent = node.parent;
          const written =
            (ts.isBinaryExpression(parent) &&
              parent.left === node &&
              parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ts.isDeleteExpression(parent) ||
            ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
              (parent.operator === ts.SyntaxKind.PlusPlusToken ||
                parent.operator === ts.SyntaxKind.MinusMinusToken));
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
    transform,
    releaseAnalysis: () => parsed.clear(),
    report: () => Object.fromEntries([...hits].sort(([a], [b]) => a.localeCompare(b))),
  };
}

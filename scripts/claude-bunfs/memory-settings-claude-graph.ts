import ts from "typescript-legacy";
// @effect-diagnostics nodeBuiltinImport:off - build-time module names use POSIX separators.
import * as NodePath from "node:path";
import { ScopedBindings } from "./release-inventory-scope.ts";

export type ClaudeFunctionWithBody = ts.FunctionLikeDeclaration & {
  readonly body: ts.Block | ts.Expression;
};

export interface ClaudeParsedSource {
  readonly name: string;
  readonly text: string;
  readonly file: ts.SourceFile;
  readonly bindings: ScopedBindings<never>;
  readonly assignments: Map<ts.Identifier, ts.Expression[]>;
  readonly unsafeWrites: Set<ts.Identifier>;
  readonly functionNodes: ClaudeFunctionWithBody[];
}

export interface ClaudeValueRef {
  readonly source: ClaudeParsedSource;
  readonly node: ts.Expression | ClaudeFunctionWithBody;
  readonly declaration?: ts.Identifier;
}

export const unwrap = (node: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  return node;
};

export function functionWithBody(node: ts.Node): node is ClaudeFunctionWithBody {
  return ts.isFunctionLike(node) && "body" in node && !!node.body;
}

const isAssignment = (kind: ts.SyntaxKind) =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

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

export function isWrite(node: ts.Node): boolean {
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

export function staticProperty(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : undefined;
}

export function propertyName(
  node: ts.PropertyName | ts.Expression | undefined,
): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text;
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrap(node.expression);
    return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
      ? expression.text
      : undefined;
  }
  return undefined;
}

export function firstBindingIdentifier(name: ts.BindingName): ts.Identifier | undefined {
  if (ts.isIdentifier(name)) return name;
  if (!ts.isArrayBindingPattern(name)) return undefined;
  const first = name.elements.find((element) => ts.isBindingElement(element));
  return first && ts.isBindingElement(first) && ts.isIdentifier(first.name)
    ? first.name
    : undefined;
}

export function variableDeclarationForBinding(
  identifier: ts.Identifier,
): ts.VariableDeclaration | undefined {
  for (let node: ts.Node | undefined = identifier; node; node = node.parent)
    if (ts.isVariableDeclaration(node)) return node;
  return undefined;
}

function createSource(name: string, text: string): ClaudeParsedSource {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = new ScopedBindings<never>(file);
  const assignments = new Map<ts.Identifier, ts.Expression[]>();
  const unsafeWrites = new Set<ts.Identifier>();
  const functionNodes: ClaudeFunctionWithBody[] = [];

  const visit = (node: ts.Node): void => {
    if (functionWithBody(node)) functionNodes.push(node);
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left)) {
        const declaration = bindings.lookup(node.left)?.declaration;
        if (declaration) {
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const values = assignments.get(declaration) ?? [];
            values.push(node.right);
            assignments.set(declaration, values);
          } else unsafeWrites.add(declaration);
        }
      } else {
        const base =
          ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)
            ? node.left.expression
            : undefined;
        if (base && ts.isIdentifier(base)) {
          const declaration = bindings.lookup(base)?.declaration;
          if (declaration) unsafeWrites.add(declaration);
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      const declaration = bindings.lookup(node.operand)?.declaration;
      if (declaration) unsafeWrites.add(declaration);
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return { name, text, file, bindings, assignments, unsafeWrites, functionNodes };
}

/** Resolves only source identities and lexical/import bindings across extracted modules. */
export class ClaudeSourceGraph {
  private readonly raw = new Map<string, string>();
  private readonly parsed = new Map<string, ClaudeParsedSource>();
  private readonly aliases = new Map<string, Set<string>>();

  constructor(sources: ReadonlyMap<string, string>) {
    for (const [name, text] of sources) {
      this.raw.set(name, text);
      const logical = name.replace(/^bun-graph:/, "");
      for (const alias of new Set([
        name,
        logical,
        NodePath.posix.normalize(logical),
        NodePath.posix.basename(logical),
      ])) {
        const names = this.aliases.get(alias) ?? new Set<string>();
        names.add(name);
        this.aliases.set(alias, names);
      }
    }
  }

  names(): IterableIterator<string> {
    return this.raw.keys();
  }

  text(name: string): string | undefined {
    return this.raw.get(name);
  }

  source(name: string): ClaudeParsedSource | undefined {
    const existing = this.parsed.get(name);
    if (existing) return existing;
    const text = this.raw.get(name);
    if (text === undefined) return undefined;
    const source = createSource(name, text);
    this.parsed.set(name, source);
    return source;
  }

  resolveModule(importer: ClaudeParsedSource, specifier: string): ClaudeParsedSource | undefined {
    const normalized = specifier.replace(/^bun-graph:/, "");
    const candidates = [
      normalized,
      NodePath.posix.normalize(
        NodePath.posix.join(
          NodePath.posix.dirname(importer.name.replace(/^bun-graph:/, "")),
          normalized,
        ),
      ),
      NodePath.posix.basename(normalized),
    ];
    for (const candidate of candidates) {
      const names = this.aliases.get(candidate);
      if (names?.size === 1) return this.source([...names][0]!);
    }
    return undefined;
  }

  declarationValues(source: ClaudeParsedSource, declaration: ts.Identifier): ClaudeValueRef[] {
    if (source.unsafeWrites.has(declaration)) return [];
    const parent = declaration.parent;
    if (ts.isFunctionDeclaration(parent) && parent.name === declaration && functionWithBody(parent))
      return [{ source, node: parent, declaration }];
    if (ts.isVariableDeclaration(parent)) {
      const initializers = [
        ...(parent.initializer ? [parent.initializer] : []),
        ...(source.assignments.get(declaration) ?? []),
      ];
      if (initializers.length !== 1) return [];
      return [{ source, node: initializers[0]!, declaration }];
    }

    let current: ts.Node = declaration;
    while (current.parent && !ts.isImportDeclaration(current.parent)) current = current.parent;
    if (
      !current.parent ||
      !ts.isImportDeclaration(current.parent) ||
      !ts.isStringLiteralLike(current.parent.moduleSpecifier)
    )
      return [];
    const imported = this.importedName(current.parent, declaration);
    if (!imported) return [];
    const target = this.resolveModule(source, current.parent.moduleSpecifier.text);
    return target ? this.exportValues(target, imported) : [];
  }

  importedName(declaration: ts.ImportDeclaration, local: ts.Identifier): string | undefined {
    const clause = declaration.importClause;
    if (!clause) return undefined;
    if (clause.name === local) return "default";
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name === local) return "*";
    if (bindings && ts.isNamedImports(bindings)) {
      const specifier = bindings.elements.find((element) => element.name === local);
      if (specifier) return (specifier.propertyName ?? specifier.name).text;
    }
    return undefined;
  }

  importDeclaration(
    source: ClaudeParsedSource,
    declaration: ts.Identifier,
  ): ts.ImportDeclaration | undefined {
    let current: ts.Node = declaration;
    while (current.parent && !ts.isImportDeclaration(current.parent)) current = current.parent;
    return current.parent && ts.isImportDeclaration(current.parent) ? current.parent : undefined;
  }

  exportValues(
    source: ClaudeParsedSource,
    name: string,
    seen = new Set<string>(),
  ): ClaudeValueRef[] {
    const token = `${source.name}\0${name}`;
    if (seen.has(token)) return [];
    seen = new Set(seen).add(token);
    const refs: ClaudeValueRef[] = [];
    const addLocal = (localName: string) => {
      const id = source.file.statements.flatMap((statement) => {
        if (ts.isVariableStatement(statement))
          return statement.declarationList.declarations.flatMap((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === localName
              ? [declaration.name]
              : [],
          );
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === localName
        )
          return [statement.name];
        return [];
      })[0];
      if (id) refs.push(...this.declarationValues(source, id));
    };

    for (const statement of source.file.statements) {
      if (ts.isExportAssignment(statement) && name === "default")
        refs.push({ source, node: statement.expression });
      if (ts.isExportDeclaration(statement)) {
        const target =
          statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? this.resolveModule(source, statement.moduleSpecifier.text)
            : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const specifier = statement.exportClause.elements.find(
            (element) => element.name.text === name,
          );
          if (specifier) {
            const imported = (specifier.propertyName ?? specifier.name).text;
            if (target) refs.push(...this.exportValues(target, imported, seen));
            else addLocal(imported);
          }
        } else if (target && !statement.exportClause) {
          refs.push(...this.exportValues(target, name, seen));
        }
      }
      if (
        (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        addLocal(name);
    }
    return refs;
  }

  functionValues(source: ClaudeParsedSource, expression: ts.Expression): ClaudeValueRef[] {
    expression = unwrap(expression);
    if (!ts.isIdentifier(expression)) return [];
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return [];
    return this.declarationValues(source, declaration).flatMap((value) =>
      functionWithBody(value.node)
        ? [value]
        : ts.isIdentifier(value.node)
          ? this.functionValues(value.source, value.node)
          : [],
    );
  }

  isGlobalObjectMember(source: ClaudeParsedSource, node: ts.Expression, member: string): boolean {
    node = unwrap(node);
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === member &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Object" &&
      source.bindings.lookup(node.expression) === undefined
    );
  }
}

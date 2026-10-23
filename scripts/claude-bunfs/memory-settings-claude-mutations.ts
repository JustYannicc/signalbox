import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";
import { propertyName, staticProperty } from "./memory-settings-claude-graph.ts";

type SourceSelector = (node: ts.Node, source: ts.SourceFile) => ts.Node | undefined;

function containsSettingRead(node: ts.Node, key: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) &&
      staticProperty(child) === key
    )
      found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function staticNumber(
  bindings: ScopedBindings<never>,
  expression: ts.Expression,
  seen = new Set<ts.Identifier>(),
): number | undefined {
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken ||
      expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = staticNumber(bindings, expression.operand, seen);
    return value === undefined
      ? undefined
      : expression.operator === ts.SyntaxKind.MinusToken
        ? -value
        : value;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const declaration = bindings.lookup(expression)?.declaration;
  if (!declaration || seen.has(declaration)) return undefined;
  seen.add(declaration);
  const parent = declaration.parent;
  if (!ts.isVariableDeclaration(parent) || !parent.initializer) return undefined;
  return staticNumber(bindings, parent.initializer, seen);
}

function replaceNode(
  sources: ReadonlyMap<string, string>,
  name: string,
  source: ts.SourceFile,
  node: ts.Node,
  replacement: string,
): Map<string, string> {
  const text = sources.get(name);
  if (text === undefined) throw new Error("CLAUDE_MUTATION_SOURCE_MISSING");
  return new Map(sources).set(
    name,
    `${text.slice(0, node.getStart(source))}${replacement}${text.slice(node.end)}`,
  );
}

function mutateFirst(
  sources: ReadonlyMap<string, string>,
  key: string,
  select: SourceSelector,
  replacement: string,
): Map<string, string> {
  for (const [name, text] of sources) {
    if (!text.includes(key)) continue;
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let selected: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (selected) return;
      selected = select(node, source);
      if (!selected) ts.forEachChild(node, visit);
    };
    visit(source);
    if (selected) return replaceNode(sources, name, source, selected, replacement);
  }
  throw new Error(`CLAUDE_MUTATION_TARGET_MISSING: ${key}`);
}

export function omitClaudeSettingSources(
  sources: ReadonlyMap<string, string>,
  key: string,
): Map<string, string> {
  return new Map([...sources].filter(([, text]) => !text.includes(key)));
}

export function renameClaudeSettingSources(
  sources: ReadonlyMap<string, string>,
  key: string,
): Map<string, string> {
  return new Map(
    [...sources].map(([name, text]) => [name, text.replaceAll(key, `${key}_RENAMED`)]),
  );
}

export function mutateClaudeParserArgument(
  sources: ReadonlyMap<string, string>,
  key: string,
  argumentIndex: number,
  replacement: string,
): Map<string, string> {
  return mutateFirst(
    sources,
    key,
    (node) => {
      if (!ts.isCallExpression(node)) return undefined;
      const name = node.arguments[0];
      const read = node.arguments[1];
      return name &&
        ts.isStringLiteralLike(name) &&
        name.text === key &&
        read &&
        containsSettingRead(read, key)
        ? node.arguments[argumentIndex]
        : undefined;
    },
    replacement,
  );
}

export function mutateClaudeDirectFallback(
  sources: ReadonlyMap<string, string>,
  key: string,
  current: number,
  replacement: string,
): Map<string, string> {
  return mutateFirst(
    sources,
    key,
    (node, source) => {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !containsSettingRead(node.left, key)
      )
        return undefined;
      const bindings = new ScopedBindings<never>(source);
      return staticNumber(bindings, node.right) === current ? node.right : undefined;
    },
    replacement,
  );
}

export function mutateClaudeCallFallback(
  sources: ReadonlyMap<string, string>,
  key: string,
  current: number,
  replacement: string,
): Map<string, string> {
  return mutateFirst(
    sources,
    key,
    (node, source) => {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isCallExpression(node.left)
      )
        return undefined;
      const bindings = new ScopedBindings<never>(source);
      return staticNumber(bindings, node.right) === current ? node.right : undefined;
    },
    replacement,
  );
}

export function mutateClaudeTypedDescriptor(
  sources: ReadonlyMap<string, string>,
  key: string,
  replacement: string,
): Map<string, string> {
  return mutateFirst(
    sources,
    key,
    (node) =>
      ts.isPropertyAssignment(node) && propertyName(node.name) === key
        ? node.initializer
        : undefined,
    replacement,
  );
}

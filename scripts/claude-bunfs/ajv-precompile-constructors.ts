import ts from "typescript-legacy";

export class AjvConstructorTransformError extends Error {
  readonly code = "AJV_CONSTRUCTOR_UNSUPPORTED";
  readonly module: string;
  readonly offset: number;
  constructor(module: string, offset: number, reason: string) {
    super(reason);
    this.name = "AjvConstructorTransformError";
    this.module = module;
    this.offset = offset;
  }
  toJSON() {
    return { code: this.code, module: this.module, offset: this.offset, message: this.message };
  }
}

export function insertAjvBinding(
  source: string,
  binding: string,
  format?: "commonjs" | "module" | 1 | 2,
) {
  if (format !== "commonjs" && format !== 2) {
    const offset = source.startsWith("#!") ? source.indexOf("\n") : -1;
    return offset >= 0
      ? `${source.slice(0, offset + 1)}${binding}\n${source.slice(offset + 1)}`
      : source.startsWith("#!")
        ? `${source}\n${binding}\n`
        : `${binding}\n${source}`;
  }
  const parsed = ts.createSourceFile(
    "binding.cjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let offset = parsed.statements[0]?.getStart(parsed) ?? source.length;
  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    offset = statement.end;
  }
  return `${source.slice(0, offset)}\n${binding}\n${source.slice(offset)}`;
}

/** Replace bundled AJV's exported dialect classes, so internal lazy factories keep their normal bindings. */
export function replaceEmbeddedAjvConstructors(
  input: { key: string; source: string; format?: "commonjs" | "module" | 1 | 2 },
  adapterSpecifier: string,
) {
  const sourceFile = ts.createSourceFile(
    input.key,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const replacements = new Map<
    ts.ClassDeclaration | ts.ClassExpression,
    { name: string; dialect: "draft7" | "2019" | "2020" }
  >();
  const assignments: {
    scope: ts.Node;
    name?: string;
    dialect: "draft7" | "2019" | "2020";
    offset: number;
  }[] = [];
  const scopeOf = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (
      current &&
      !ts.isFunctionLike(current) &&
      !ts.isSourceFile(current) &&
      !ts.isBlock(current)
    )
      current = current.parent;
    return current ?? sourceFile;
  };
  walk(sourceFile, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const name = node.left.name.text;
      if (name === "Ajv" || name === "Ajv2019" || name === "Ajv2020") {
        let value = node.right;
        while (ts.isParenthesizedExpression(value)) value = value.expression;
        if (ts.isVoidExpression(value) || (ts.isIdentifier(value) && value.text === "undefined"))
          return;
        assignments.push({
          scope: scopeOf(node),
          ...(ts.isIdentifier(value) ? { name: value.text } : {}),
          offset: node.getStart(sourceFile),
          dialect: name === "Ajv2020" ? "2020" : name === "Ajv2019" ? "2019" : "draft7",
        });
      }
    }
  });
  walk(sourceFile, (node) => {
    if (
      (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) ||
      !node.heritageClauses?.length
    )
      return;
    const name =
      ts.isClassExpression(node) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
        ? node.parent.name.text
        : node.name?.text;
    if (!name) return;
    const methods = new Set(node.members.map((member) => member.name?.getText(sourceFile)));
    const assignment = assignments.find(
      (item) => item.scope === scopeOf(node) && item.name === name,
    );
    if (!assignment) return;
    if (methods.has("compileSerializer") || methods.has("compileParser"))
      throw new AjvConstructorTransformError(
        input.key,
        node.getStart(sourceFile),
        "AJV JTD constructors require a dedicated compiler profile",
      );
    if (
      !methods.has("_addVocabularies") ||
      !methods.has("_addDefaultMetaSchema") ||
      !methods.has("defaultMeta")
    )
      return;
    replacements.set(node, { dialect: assignment.dialect, name });
  });
  for (const assignment of assignments) {
    const matches = [...replacements].filter(
      ([node, replacement]) =>
        scopeOf(node) === assignment.scope && replacement.name === assignment.name,
    );
    if (matches.length !== 1 || matches[0]?.[1].dialect !== assignment.dialect)
      throw new AjvConstructorTransformError(
        input.key,
        assignment.offset,
        "Known AJV export has an unresolved or ambiguous constructor binding",
      );
  }
  let source = input.source;
  let identifier = "__signalboxInterpretedAjv";
  while (input.source.includes(identifier)) identifier += "_";
  for (const [node, { name, dialect }] of [...replacements].sort(
    ([a], [b]) => b.getStart(sourceFile) - a.getStart(sourceFile),
  )) {
    const replacement = `${identifier}(${JSON.stringify(dialect)})`;
    source = `${source.slice(0, node.getStart(sourceFile))}${ts.isClassDeclaration(node) ? `const ${name}=${replacement};` : replacement}${source.slice(node.end)}`;
  }
  if (replacements.size) {
    const binding =
      input.format === "commonjs" || input.format === 2
        ? `const {createAjv:${identifier}}=require(${JSON.stringify(adapterSpecifier)});`
        : `import { createAjv as ${identifier} } from ${JSON.stringify(adapterSpecifier)};`;
    source = insertAjvBinding(source, binding, input.format);
  }
  return {
    source,
    constructors: [...replacements].map(([node, { name, dialect }]) => ({
      module: input.key,
      offset: node.getStart(sourceFile),
      name,
      dialect,
    })),
  };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// @effect-diagnostics nodeBuiltinImport:off - preserve guest module URLs at build time.
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { shadowedMetaRequires } from "./normalize-bindings.ts";

export interface NormalizeInput {
  readonly name: string;
  readonly key: string;
  readonly source: string;
  readonly format: number;
  readonly isEntry?: boolean;
}

/** Bun stores CJS as an uncalled wrapper; esbuild must see its body as CJS. */
export function normalizeModule(input: NormalizeInput) {
  const windows = /^[A-Za-z]:[\\/]/.test(input.name);
  const dirname = windows
    ? NodePath.win32.dirname(input.name)
    : input.name.slice(0, input.name.lastIndexOf("/"));
  let source = input.source;
  if (input.format === 2) {
    const ast = parse(input.name, source);
    const statement = ast.statements[0];
    if (ast.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement))
      throw new Error(`BUN_CJS_SHAPE_CHANGED: ${input.name}`);
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (
      !ts.isFunctionExpression(expression) ||
      expression.name ||
      expression.asteriskToken ||
      expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      expression.parameters.some(
        (parameter) => parameter.dotDotDotToken || parameter.initializer,
      ) ||
      expression.parameters.map((parameter) => parameter.name.getText(ast)).join(",") !==
        "exports,require,module,__filename,__dirname"
    )
      throw new Error(`BUN_CJS_SHAPE_CHANGED: ${input.name}`);
    const bodyStart = expression.body.getStart(ast) + 1;
    let directiveEnd = bodyStart;
    for (const statement of expression.body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      directiveEnd = statement.end;
    }
    source =
      source.slice(bodyStart, directiveEnd) +
      `\nvar __filename=${JSON.stringify(input.name)},__dirname=${JSON.stringify(dirname)};\n` +
      source.slice(directiveEnd, expression.body.end - 1);
  } else if (input.format !== 1) {
    throw new Error(`BUN_MODULE_FORMAT_UNSUPPORTED: ${input.name}: ${input.format}`);
  }
  const ast = parse(input.name, source);
  const shadowed = shadowedMetaRequires(ast, input.format === 1);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (ts.isPropertyAccessExpression(node)
        ? node.name.text === "url"
        : node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === "url")
    ) {
      // Chunk URLs belong to the loader; guest paths belong to the original source module.
      if (!windows && !input.name.startsWith("/"))
        throw new Error(`BUN_MODULE_URL_PATH_INVALID: ${input.name}`);
      const url = NodeURL.pathToFileURL(input.name, { windows }).href;
      edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(url) });
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.name.text === "require") {
        if (shadowed.has(node))
          throw new Error(`BUN_REQUIRE_SHADOWED: ${input.name}:${node.getStart(ast)}`);
        edits.push({ start: node.getStart(ast), end: node.end, text: "require" });
      } else if (node.name.text === "dir" || node.name.text === "dirname")
        edits.push({
          start: node.getStart(ast),
          end: node.end,
          text: JSON.stringify(dirname),
        });
      else if (node.name.text === "path" || node.name.text === "filename")
        edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(input.name) });
      else if (node.name.text === "main")
        edits.push({
          start: node.getStart(ast),
          end: node.end,
          text: String(input.isEntry === true),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const edit of edits.sort((left, right) => right.start - left.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { ...input, source, extension: input.format === 2 ? ".cjs" : ".mjs" };
}

function parse(name: string, source: string) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // TypeScript exposes parser diagnostics at runtime but omits them from SourceFile's type.
  if (
    "parseDiagnostics" in ast &&
    Array.isArray(ast.parseDiagnostics) &&
    ast.parseDiagnostics.length
  )
    throw new Error(`BUN_SOURCE_PARSE_FAILED: ${name}`);
  return ast;
}

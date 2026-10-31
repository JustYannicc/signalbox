import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

export function findUnboundedCallSpreads(source: string, fileName = "source.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const pending: ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        if (!ts.isSpreadElement(argument)) continue;
        const expression = unwrap(argument.expression);
        if (
          ts.isArrayLiteralExpression(expression) &&
          expression.elements.every((element) => !ts.isSpreadElement(element))
        ) {
          continue;
        }
        const position = file.getLineAndCharacterOfPosition(argument.getStart(file));
        findings.push({ line: position.line + 1, column: position.character + 1 });
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return findings;
}

export async function checkCallSpreads(root: string) {
  const findings = [];
  const files = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.name)) continue;
    const path = NodePath.join(file.parentPath, file.name);
    const source = await NodeFSP.readFile(path, "utf8");
    for (const finding of findUnboundedCallSpreads(source, path)) {
      findings.push({ file: NodePath.relative(root, path), ...finding });
    }
  }
  return findings;
}

if (import.meta.main) {
  const findings = await checkCallSpreads(NodeURL.fileURLToPath(new URL(".", import.meta.url)));
  for (const finding of findings) {
    NodeProcess.stderr.write(
      `${finding.file}:${finding.line}:${finding.column}: unbounded call spread; use a loop or fixed arguments\n`,
    );
  }
  if (findings.length > 0) NodeProcess.exit(1);
}

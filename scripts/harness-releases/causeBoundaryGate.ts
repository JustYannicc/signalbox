import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

const callbackNames = new Set(["catch", "catchCause", "mapError", "catchTag", "catchIf"]);

function name(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function isErrorCallback(node: ts.ArrowFunction | ts.FunctionExpression) {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) && callbackNames.has(name(parent.name) ?? "")) ||
    (ts.isCallExpression(parent) && callbackNames.has(name(parent.expression) ?? ""))
  );
}

function throwable(
  node: ts.Expression,
  unknownParameters = true,
  untypedErrorText = false,
): boolean {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node) && node.name.text === "cause") return true;
  if (!ts.isIdentifier(node)) return false;
  const identifier = node.text;
  for (let scope: ts.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isCatchClause(scope) && name(scope.variableDeclaration?.name) === identifier)
      return true;
    if (
      ts.isArrowFunction(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isFunctionDeclaration(scope)
    ) {
      const parameter = scope.parameters.find((parameter) => name(parameter.name) === identifier);
      if (parameter !== undefined) {
        return (
          (untypedErrorText && parameter.type === undefined) ||
          (unknownParameters && parameter.type?.kind === ts.SyntaxKind.UnknownKeyword) ||
          (parameter.type !== undefined && /\bCause\b/.test(parameter.type.getText())) ||
          (!ts.isFunctionDeclaration(scope) && isErrorCallback(scope))
        );
      }
    }
  }
  return false;
}

function ownsCause(node: ts.ObjectLiteralExpression) {
  return node.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      name(property.name) === "cause",
  );
}

export function findLossyHarnessCauses(source: string, fileName = "input.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const findings: Array<{ line: number; column: number; message: string }> = [];
  // Code cells have a separate guest protocol whose error result is text.
  const structured = !fileName.replaceAll("\\", "/").includes("/harness/codeMode/");
  const report = (node: ts.Node, message: string) => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ line: position.line + 1, column: position.character + 1, message });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ["HarnessError", "HarnessRequestFacetError"].includes(name(node.expression) ?? "")
    ) {
      let callback: ts.Node | undefined = node.parent;
      while (
        callback !== undefined &&
        !ts.isCatchClause(callback) &&
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)
      )
        callback = callback.parent;
      if (
        callback !== undefined &&
        (ts.isCatchClause(callback) || isErrorCallback(callback)) &&
        !(node.arguments ?? []).some(
          (argument) => ts.isObjectLiteralExpression(argument) && ownsCause(argument),
        )
      ) {
        report(node, "Keep the caught failure in cause when constructing a Harness error.");
      }
    }
    if (structured && ts.isCallExpression(node)) {
      const stringConversion = name(node.expression) === "String";
      const errorText = ts.isNewExpression(node.parent) && name(node.parent.expression) === "Error";
      const jsonConversion =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === "JSON" &&
        node.expression.name.text === "stringify";
      if (
        (stringConversion || jsonConversion) &&
        node.arguments.some((argument) => throwable(argument, stringConversion, errorText))
      ) {
        report(node, "Encode throwable values with serializeHarnessFailure before rendering them.");
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "squash" &&
        node.expression.expression.getText(file) === "Cause"
      ) {
        report(node, "Keep every Cause reason instead of squashing the failure.");
      }
    }
    if (
      structured &&
      ts.isTemplateExpression(node) &&
      node.templateSpans.some((span) => throwable(span.expression))
    ) {
      report(node, "Do not interpolate a throwable object into error text.");
    }
    if (
      structured &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      ((ts.isStringLiteralLike(node.left) && throwable(node.right)) ||
        (ts.isStringLiteralLike(node.right) && throwable(node.left)))
    ) {
      report(node, "Do not concatenate a throwable object into error text.");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

export async function checkHarnessCauseBoundaries(root: string) {
  const findings = [];
  for (const owner of [
    "apps/cloud/src/harness",
    "apps/cloud/infra/deploy3/qualification/fixture",
  ]) {
    const directory = NodePath.join(root, owner);
    for (const file of await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.[cm]?[jt]s$/.test(file.name)) continue;
      const path = NodePath.join(file.parentPath, file.name);
      const relative = NodePath.relative(root, path);
      if (
        /(?:^|\/)(?:tests?|fixtures?)\//.test(NodePath.relative(directory, path)) ||
        /\.(?:test|fixture)\.[cm]?[jt]s$/.test(file.name)
      )
        continue;
      const source = await NodeFSP.readFile(path, "utf8");
      for (const finding of findLossyHarnessCauses(source, relative))
        findings.push({ file: relative, ...finding });
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
  const findings = await checkHarnessCauseBoundaries(root);
  for (const finding of findings)
    NodeProcess.stderr.write(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.message}\n`,
    );
  process.exitCode = findings.length === 0 ? 0 : 1;
}

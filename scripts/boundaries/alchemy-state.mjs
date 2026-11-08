import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript-legacy";

import { VENDORED_ROOTS } from "./upstream.mjs";

const SHARED_STATE_STACKS = new Set([
  "apps/cloud/alchemy.run.ts",
  // Upstream production stack: shares the v8 exposure. Keep its workflow disabled
  // until the fork's package/config fix covers both production stacks.
  "infra/relay/alchemy.run.ts",
]);

export function sharedCloudflareStateCalls(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const namespaces = new Set();
  const functions = new Set();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^(?:alchemy\/Cloudflare|@alchemy.run\/cloudflare)(?:\/StateStore(?:\/State)?)?$/.test(
        statement.moduleSpecifier.text,
      )
    )
      continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === "state") {
          functions.add(binding.name.text);
        }
      }
    }
  }
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const direct = ts.isIdentifier(callee) && functions.has(callee.text);
      const member =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "state") ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteral(callee.argumentExpression) &&
          callee.argumentExpression.text === "state");
      if (
        direct ||
        (member && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text))
      ) {
        lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return lines;
}

export function checkAlchemyState(
  root,
  files,
  readSource = (file) => {
    const path = NodePath.join(root, file);
    return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : undefined;
  },
) {
  return files.flatMap((file) => {
    if (
      file.startsWith(".repos/") ||
      VENDORED_ROOTS.some((prefix) => file.startsWith(prefix)) ||
      !/\.[cm]?[jt]sx?$/.test(file) ||
      SHARED_STATE_STACKS.has(file)
    )
      return [];
    const source = readSource(file);
    if (source === undefined || !/alchemy\/Cloudflare|@alchemy.run\/cloudflare/.test(source))
      return [];
    return sharedCloudflareStateCalls(file, source).map(
      (line) =>
        `${file}:${line}: disposable stacks must use Alchemy.localState(); Cloudflare.state() can downgrade the account's shared state-store Worker`,
    );
  });
}

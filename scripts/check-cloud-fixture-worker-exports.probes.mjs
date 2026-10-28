import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import ts from "typescript-legacy";

const probeConfigs = new Map([["infra/syncProbe/worker.ts", ["alchemy.run.ts"]]]);

async function parse(file) {
  return ts.createSourceFile(
    file,
    await NodeFSP.readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function declaredNames(source) {
  const names = new Set();
  for (const statement of source.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (ts.isClassDeclaration(statement) && statement.name !== undefined)
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
  return names;
}

async function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = await parse(file);
  const names = declaredNames(source);
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements)
        if (!element.isTypeOnly) names.add(element.name.text);
    } else if (
      statement.exportClause === undefined &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      const target = NodePath.resolve(NodePath.dirname(file), statement.moduleSpecifier.text);
      for (const name of await exportedNames(target, seen)) names.add(name);
    }
  }
  return names;
}

function bindingNames(source) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "classExports"
    ) {
      let value = node.initializer;
      while (value !== undefined && (ts.isSatisfiesExpression(value) || ts.isAsExpression(value)))
        value = value.expression;
      if (value === undefined || !ts.isObjectLiteralExpression(value))
        throw new Error(`${source.fileName}: cannot resolve probe classExports`);
      for (const property of value.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
          property.initializer.kind !== ts.SyntaxKind.TrueKeyword
        )
          throw new Error(`${source.fileName}: cannot resolve probe class export`);
        names.add(property.name.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "DurableObject"
    ) {
      const options = node.arguments[1];
      const explicit =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === "className",
            )
          : undefined;
      const name = explicit?.initializer ?? node.arguments[0];
      if (name === undefined || !ts.isStringLiteral(name))
        throw new Error(`${source.fileName}: cannot resolve probe Durable Object binding`);
      names.add(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

export async function checkPurposeBuiltProbe(file, cloudRoot, sharedExports) {
  const configs = probeConfigs.get(NodePath.relative(cloudRoot, file));
  if (configs === undefined) return undefined;
  const source = await parse(file);
  const productionNames = await exportedNames(NodePath.join(cloudRoot, "src/worker.ts"));
  const names = await exportedNames(file);
  const failures = [];
  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      NodePath.resolve(NodePath.dirname(file), statement.moduleSpecifier.text) !== sharedExports
    )
      continue;
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;
    if (clause === undefined || (!ts.isNamedExports(clause) && !ts.isNamedImports(clause))) {
      failures.push(`${file}: purpose-built probes must import production classes by name`);
      continue;
    }
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      if (!productionNames.has(name))
        failures.push(`${file}: declared production export ${name} does not exist`);
    }
  }
  for (const config of configs) {
    const configFile = NodePath.join(NodePath.dirname(file), config);
    const bindings = bindingNames(await parse(configFile));
    if (bindings.size === 0) failures.push(`${configFile}: cannot resolve probe class bindings`);
    for (const name of bindings)
      if (!names.has(name)) failures.push(`${configFile}: binding ${name} has no probe export`);
  }
  return failures;
}

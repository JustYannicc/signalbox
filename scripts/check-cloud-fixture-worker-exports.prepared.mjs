import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import ts from "typescript-legacy";

function namedProperty(node, name) {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
}

function isProperty(node, receiver, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === receiver &&
    node.name.text === name
  );
}

function importBinding(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if (element.name.text === name)
        return { path: statement.moduleSpecifier.text, name: element.propertyName?.text ?? name };
  }
  return undefined;
}

function variable(sourceFile, name) {
  let result;
  const visit = (node) => {
    if (result !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function variableWithin(root, name) {
  let result;
  const visit = (node) => {
    if (result !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function containsIdentifier(root, name) {
  return findNode(root, (node) => ts.isIdentifier(node) && node.text === name) !== undefined;
}

function candidateImport(sourceFile, specifier, candidates) {
  const base = NodePath.resolve(NodePath.dirname(sourceFile.fileName), specifier);
  return candidates.find(({ filePath }) =>
    [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`].includes(
      NodePath.resolve(filePath),
    ),
  );
}

function expressionName(node, sourceFile) {
  return node === undefined ? undefined : node.getText(sourceFile);
}

function importMetaUrl(node, sourceFile) {
  return ts.isPropertyAccessExpression(node) && node.getText(sourceFile) === "import.meta.url";
}

function urlLiteral(node, value, sourceFile) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "URL" &&
    ts.isStringLiteralLike(node.arguments?.[0]) &&
    node.arguments[0].text === value &&
    importMetaUrl(node.arguments?.[1], sourceFile)
  );
}

function urlInGeneratedDirectory(node, value) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "URL" &&
    ts.isStringLiteralLike(node.arguments?.[0]) &&
    node.arguments[0].text === value &&
    ts.isIdentifier(node.arguments?.[1]) &&
    node.arguments[1].text === "dir"
  );
}

function callMethod(node, method) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method
  );
}

function findCall(sourceFile, predicate) {
  let result;
  const visit = (node) => {
    if (result !== undefined) return;
    if (ts.isCallExpression(node) && predicate(node)) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function findNode(root, predicate) {
  let result;
  const visit = (node) => {
    if (result !== undefined) return;
    if (predicate(node)) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function sharedBundleWrite(prepared, sharedExports) {
  const bundle = variable(prepared.sourceFile, "fixtureWorkerExports");
  const build = ts.isAwaitExpression(bundle?.initializer)
    ? bundle.initializer.expression
    : bundle?.initializer;
  if (!ts.isCallExpression(build) || !callMethod(build, "build")) return false;
  const options = build.arguments[0];
  const entries = namedProperty(options, "entryPoints")?.initializer;
  if (!ts.isArrayLiteralExpression(entries) || entries.elements.length !== 1) return false;
  const entry = entries.elements[0];
  if (!ts.isCallExpression(entry) || !callMethod(entry, "fileURLToPath")) return false;
  const url = entry.arguments[0];
  if (!urlLiteral(url, "../../src/FixtureWorkerExports.ts", prepared.sourceFile)) return false;
  const sourcePath = NodePath.resolve(NodePath.dirname(prepared.filePath), url.arguments[0].text);
  const bundleOption = namedProperty(options, "bundle")?.initializer;
  if (sourcePath !== sharedExports || bundleOption?.kind !== ts.SyntaxKind.TrueKeyword)
    return false;

  const source = variable(prepared.sourceFile, "fixtureWorkerExportsSource");
  const sourceValue = source?.initializer;
  if (
    !ts.isPropertyAccessExpression(sourceValue) ||
    sourceValue.name.text !== "text" ||
    !ts.isElementAccessExpression(sourceValue.expression) ||
    sourceValue.expression.argumentExpression?.getText(prepared.sourceFile) !== "0" ||
    !isProperty(sourceValue.expression.expression, "fixtureWorkerExports", "outputFiles")
  )
    return false;
  const write = findCall(
    prepared.sourceFile,
    (node) =>
      callMethod(node, "writeFile") &&
      urlInGeneratedDirectory(node.arguments[0], "FixtureWorkerExports.js") &&
      ts.isIdentifier(node.arguments[1]) &&
      node.arguments[1].text === "fixtureWorkerExportsSource",
  );
  return write !== undefined;
}

function loopForName(sourceFile, expectedName) {
  return findNode(sourceFile, (node) => {
    if (!ts.isForOfStatement(node) || !ts.isArrayLiteralExpression(node.expression)) return false;
    return node.expression.elements.some(
      (element) => ts.isStringLiteralLike(element) && element.text === expectedName,
    );
  });
}

function loopVariable(loop) {
  const declaration = ts.isVariableDeclarationList(loop.initializer)
    ? loop.initializer.declarations[0]
    : undefined;
  return declaration !== undefined && ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : undefined;
}

function templatePath(node, head, suffix, variableName) {
  return (
    ts.isTemplateExpression(node) &&
    node.head.text === head &&
    node.templateSpans.length === 1 &&
    ts.isIdentifier(node.templateSpans[0].expression) &&
    node.templateSpans[0].expression.text === variableName &&
    node.templateSpans[0].literal.text === suffix
  );
}

function generatedWorkerLoop(prepared) {
  const loop = loopForName(prepared.sourceFile, "worker");
  const name = loop === undefined ? undefined : loopVariable(loop);
  if (loop === undefined || name === undefined) return false;
  let readsSource = false;
  let writesWorker = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && callMethod(node, "readFile")) {
      const url = node.arguments[0];
      if (
        ts.isNewExpression(url) &&
        ts.isIdentifier(url.expression) &&
        url.expression.text === "URL" &&
        templatePath(url.arguments?.[0], "./", ".ts", name) &&
        importMetaUrl(url.arguments?.[1], prepared.sourceFile)
      )
        readsSource = true;
    }
    if (ts.isCallExpression(node) && callMethod(node, "writeFile")) {
      const url = node.arguments[0];
      if (
        ts.isNewExpression(url) &&
        ts.isIdentifier(url.expression) &&
        url.expression.text === "URL" &&
        templatePath(url.arguments?.[0], "", ".js", name) &&
        ts.isIdentifier(url.arguments?.[1]) &&
        url.arguments[1].text === "dir" &&
        ts.isIdentifier(node.arguments[1]) &&
        node.arguments[1].text === "js"
      )
        writesWorker = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(loop.statement);
  const source = variableWithin(loop.statement, "source")?.initializer;
  const js = variableWithin(loop.statement, "js")?.initializer;
  const sourceRead = ts.isAwaitExpression(source) ? source.expression : source;
  const sourceUrl = ts.isCallExpression(sourceRead) ? sourceRead.arguments[0] : undefined;
  const readsWorkerSource =
    readsSource &&
    callMethod(sourceRead, "readFile") &&
    ts.isNewExpression(sourceUrl) &&
    ts.isIdentifier(sourceUrl.expression) &&
    sourceUrl.expression.text === "URL" &&
    templatePath(sourceUrl.arguments?.[0], "./", ".ts", name) &&
    importMetaUrl(sourceUrl.arguments?.[1], prepared.sourceFile);
  const rewritesTypes =
    js !== undefined &&
    containsIdentifier(js, "source") &&
    findNode(js, (node) => {
      if (!ts.isCallExpression(node) || !callMethod(node, "replaceAll")) return false;
      const pattern = node.arguments[0];
      const replacement = node.arguments[1];
      return (
        pattern !== undefined &&
        ts.isRegularExpressionLiteral(pattern) &&
        pattern.text.includes("\\.ts") &&
        ts.isStringLiteralLike(replacement) &&
        replacement.text.includes(".js")
      );
    }) !== undefined;
  return readsWorkerSource && rewritesTypes && writesWorker;
}

function rootCallsPrepare(rootSourceFile, prepared) {
  const imported = importBinding(rootSourceFile, "prepare");
  if (
    imported === undefined ||
    candidateImport(rootSourceFile, imported.path, [prepared]) === undefined
  )
    return undefined;
  return findCall(
    rootSourceFile,
    (node) => ts.isIdentifier(node.expression) && node.expression.text === imported.name,
  );
}

function rootCopiesGeneratedDirectory(rootSourceFile, baseLocation) {
  const destination = baseLocation?.expression;
  if (destination === undefined) return undefined;
  return findCall(rootSourceFile, (node) => {
    if (
      !callMethod(node, "cp") ||
      expressionName(node.arguments[1], rootSourceFile) !==
        expressionName(destination, rootSourceFile)
    )
      return false;
    const source = node.arguments[0];
    if (!ts.isCallExpression(source) || !callMethod(source, "join")) return false;
    return (
      ts.isPropertyAccessExpression(source.arguments[0]) &&
      source.arguments[0].getText(rootSourceFile) === "import.meta.dirname" &&
      ts.isStringLiteralLike(source.arguments[1]) &&
      source.arguments[1].text === "generated"
    );
  });
}

function rootCopiesNamedWorkerModule(rootSourceFile, baseLocation) {
  const destination = baseLocation?.expression;
  if (destination === undefined) return undefined;
  const loop = loopForName(rootSourceFile, "FixtureWorkerExports");
  const name = loop === undefined ? undefined : loopVariable(loop);
  if (loop === undefined || name === undefined) return undefined;
  return findCall(loop.statement, (node) => {
    if (!callMethod(node, "copyFile")) return false;
    const sourceUrl = node.arguments[0];
    const destinationPath = node.arguments[1];
    if (
      !ts.isNewExpression(sourceUrl) ||
      !ts.isIdentifier(sourceUrl.expression) ||
      sourceUrl.expression.text !== "URL" ||
      !templatePath(sourceUrl.arguments?.[0], "./generated/", ".js", name) ||
      !importMetaUrl(sourceUrl.arguments?.[1], rootSourceFile) ||
      !ts.isCallExpression(destinationPath) ||
      !callMethod(destinationPath, "join") ||
      expressionName(destinationPath.arguments[0], rootSourceFile) !==
        expressionName(destination, rootSourceFile)
    )
      return false;
    return templatePath(destinationPath.arguments[1], "", ".js", name);
  });
}

async function preparedProbeTarget(target, template, candidates, context) {
  const rootSourceFile = template.rootSourceFile;
  if (rootSourceFile === undefined) return false;
  const imported = importBinding(rootSourceFile, "prepare");
  const prepared =
    imported === undefined ? undefined : candidateImport(rootSourceFile, imported.path, candidates);
  if (prepared === undefined) return false;
  const prepareCall = rootCallsPrepare(rootSourceFile, prepared);
  if (prepareCall === undefined || !sharedBundleWrite(prepared, context.sharedExports))
    return false;
  if (target === "./FixtureWorkerExports.js") {
    const copy = rootCopiesNamedWorkerModule(rootSourceFile, template.baseLocation);
    return copy !== undefined && prepareCall.pos < copy.pos;
  }
  if (target === "./worker.js") {
    const copy = rootCopiesGeneratedDirectory(rootSourceFile, template.baseLocation);
    if (copy === undefined || prepareCall.pos >= copy.pos || !generatedWorkerLoop(prepared))
      return false;
    const workerPath = NodePath.join(NodePath.dirname(prepared.filePath), "worker.ts");
    const source = await NodeFSP.readFile(workerPath, "utf8").catch(() => undefined);
    if (source === undefined) return false;
    return context
      .exportStars(ts.createSourceFile(workerPath, source, ts.ScriptTarget.Latest, true))
      .includes("./FixtureWorkerExports.ts");
  }
  return false;
}

export async function preparedModuleReachesShared(target, template, candidates, context) {
  return preparedProbeTarget(target, template, candidates, context);
}

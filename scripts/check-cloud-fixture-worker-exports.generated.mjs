import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";
import { preparedModuleReachesShared } from "./check-cloud-fixture-worker-exports.prepared.mjs";

function namedProperty(node, name) {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === name;
    if (!ts.isPropertyAssignment(property)) return false;
    return (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    );
  });
}

function propertyValue(property) {
  if (property === undefined) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function findVariable(sourceFile, name) {
  let found;
  const visit = (node) => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findFunction(sourceFile, name) {
  for (const statement of sourceFile.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  const initializer = findVariable(sourceFile, name)?.initializer;
  return initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

function findImport(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if (element.name.text === name)
        return {
          specifier: statement.moduleSpecifier.text,
          importedName: element.propertyName?.text ?? name,
        };
  }
  return undefined;
}

function candidateImport(sourceFile, specifier, candidates) {
  const base = NodePath.resolve(NodePath.dirname(sourceFile.fileName), specifier);
  const paths = new Set([base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`]);
  return candidates.find(({ filePath }) => paths.has(NodePath.resolve(filePath)));
}

function firstReturn(fn) {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body;
  let result;
  const visit = (node) => {
    if (result !== undefined || (node !== fn && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      result = node.expression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body !== undefined) visit(fn.body);
  return result;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return node;
}

function directoryLocation(node, sourceFile, seen = new Set()) {
  if (node === undefined) return undefined;
  node = unwrap(node);
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    const initializer = findVariable(sourceFile, node.text)?.initializer;
    return initializer === undefined
      ? undefined
      : directoryLocation(initializer, sourceFile, new Set(seen).add(node.text));
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (
      (method === "join" || method === "resolve") &&
      node.arguments.length === 2 &&
      (ts.isStringLiteralLike(node.arguments[1]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[1]))
    )
      return { expression: node.arguments[0], sourceFile };
  }
  if (ts.isStringLiteralLike(node) && NodePath.isAbsolute(node.text))
    return { absolutePath: NodePath.dirname(node.text), sourceFile };
  return undefined;
}

function staticPathPart(node, sourceFile, seen = new Set()) {
  if (node === undefined) return undefined;
  node = unwrap(node);
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    const initializer = findVariable(sourceFile, node.text)?.initializer;
    return initializer === undefined
      ? undefined
      : staticPathPart(initializer, sourceFile, new Set(seen).add(node.text));
  }
  if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
    if (node.name.text === "dirname") return NodePath.dirname(sourceFile.fileName);
    if (node.name.text === "url") return NodeURL.pathToFileURL(sourceFile.fileName);
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "URL"
  ) {
    const relative = staticPathPart(node.arguments?.[0], sourceFile, seen);
    const base = node.arguments?.[1];
    if (
      relative !== undefined &&
      base !== undefined &&
      ts.isPropertyAccessExpression(base) &&
      base.getText(sourceFile) === "import.meta.url"
    )
      return new URL(relative, NodeURL.pathToFileURL(sourceFile.fileName));
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const receiver = node.expression.expression;
    if (
      ts.isIdentifier(receiver) &&
      receiver.text === "NodePath" &&
      ["join", "resolve"].includes(method)
    ) {
      const args = node.arguments.map((argument) => staticPathPart(argument, sourceFile, seen));
      if (args.every((value) => typeof value === "string")) return NodePath[method](...args);
    }
    if (ts.isIdentifier(receiver) && receiver.text === "NodeURL" && method === "fileURLToPath") {
      const value = staticPathPart(node.arguments[0], sourceFile, seen);
      if (value instanceof URL) return NodePath.resolve(NodeURL.fileURLToPath(value));
    }
  }
  return undefined;
}

function staticDirectory(location) {
  if (location === undefined) return undefined;
  if (location.absolutePath !== undefined) return location.absolutePath;
  const value = staticPathPart(location.expression, location.sourceFile);
  return typeof value === "string" && NodePath.isAbsolute(value)
    ? NodePath.resolve(value)
    : undefined;
}

function sourceText(expression, sourceFile, candidates, location, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression))
    return sourceText(expression.expression, sourceFile, candidates, location, seen);
  if (
    ts.isTemplateExpression(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isStringLiteralLike(expression)
  )
    return { node: expression, sourceFile, ...location };
  if (ts.isIdentifier(expression)) {
    if (seen.has(`${sourceFile.fileName}:${expression.text}`)) return undefined;
    const initializer = findVariable(sourceFile, expression.text)?.initializer;
    return initializer === undefined
      ? undefined
      : sourceText(
          initializer,
          sourceFile,
          candidates,
          location,
          new Set(seen).add(`${sourceFile.fileName}:${expression.text}`),
        );
  }
  if (ts.isCallExpression(expression)) {
    if (!ts.isIdentifier(expression.expression)) return undefined;
    const name = expression.expression.text;
    const key = `${sourceFile.fileName}:${name}`;
    if (seen.has(key)) return undefined;
    let owner = sourceFile;
    let fn = findFunction(owner, name);
    if (fn === undefined) {
      const imported = findImport(sourceFile, name);
      const candidate =
        imported === undefined
          ? undefined
          : candidateImport(sourceFile, imported.specifier, candidates);
      if (candidate === undefined || imported === undefined) return undefined;
      owner = candidate.sourceFile;
      fn = findFunction(owner, imported.importedName);
    }
    const result = fn === undefined ? undefined : firstReturn(fn);
    if (result === undefined) return undefined;
    const resolved = sourceText(result, owner, candidates, location, new Set(seen).add(key));
    return resolved === undefined
      ? undefined
      : { ...resolved, invocation: { expression, sourceFile } };
  }
  return undefined;
}

function lastStringLiteral(node, sourceFile, seen = new Set()) {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    const initializer = findVariable(sourceFile, node.text)?.initializer;
    return initializer === undefined
      ? undefined
      : lastStringLiteral(initializer, sourceFile, new Set(seen).add(node.text));
  }
  const values = [];
  const visit = (child) => {
    if (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child))
      values.push(child.text);
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return values.at(-1);
}

function mainSourceTemplates(sourceFile, main, candidates) {
  const writers = [];
  const builds = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "writeFile"
      ) {
        writers.push({
          name: lastStringLiteral(node.arguments[0], sourceFile),
          source: node.arguments[1],
          location: directoryLocation(node.arguments[0], sourceFile),
        });
      }
      const buildCall =
        (ts.isIdentifier(node.expression) && node.expression.text === "build") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "build");
      if (buildCall && ts.isObjectLiteralExpression(node.arguments[0])) {
        const options = node.arguments[0];
        const stdin = namedProperty(options, "stdin")?.initializer;
        const outfile = namedProperty(options, "outfile")?.initializer;
        const resolveDir = namedProperty(stdin, "resolveDir")?.initializer;
        builds.push({
          name: lastStringLiteral(outfile, sourceFile),
          content: namedProperty(stdin, "contents")?.initializer,
          entries: namedProperty(options, "entryPoints")?.initializer,
          location:
            resolveDir === undefined
              ? directoryLocation(outfile, sourceFile)
              : { expression: resolveDir, sourceFile },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const mainName = NodePath.basename(main);
  const result = [];
  for (const build of builds) {
    if (build.name !== mainName) continue;
    if (build.content !== undefined) {
      const content = sourceText(build.content, sourceFile, candidates, {
        baseLocation: build.location,
        rootSourceFile: sourceFile,
      });
      if (content !== undefined) result.push(content);
    }
    if (build.entries === undefined) continue;
    const entries = ts.isArrayLiteralExpression(build.entries)
      ? build.entries.elements
      : [build.entries];
    for (const entry of entries) {
      const entryName = lastStringLiteral(entry, sourceFile);
      if (entryName === undefined) continue;
      const mainStem = NodePath.basename(mainName, NodePath.extname(mainName));
      const entryStem = NodePath.basename(entryName, NodePath.extname(entryName));
      if (mainStem !== entryStem) continue;
      for (const writer of writers)
        if (writer.name === entryName) {
          const content = sourceText(writer.source, sourceFile, candidates, {
            baseLocation: build.location,
            rootSourceFile: sourceFile,
          });
          if (content !== undefined) result.push(content);
        }
    }
  }
  for (const writer of writers)
    if (writer.name === mainName) {
      const content = sourceText(writer.source, sourceFile, candidates, {
        baseLocation: writer.location,
        rootSourceFile: sourceFile,
      });
      if (content !== undefined) result.push(content);
    }
  return result;
}

function isInputField(node, field) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "input" &&
    node.name.text === field
  );
}

function sourceFunctionMapsPathToCloudRoot(sourceFunction, sourceFile) {
  if (sourceFunction === undefined) return false;
  const normalized = findVariable(sourceFile, "relative")?.initializer;
  if (!ts.isCallExpression(normalized) || !ts.isPropertyAccessExpression(normalized.expression))
    return false;
  if (
    normalized.expression.name.text !== "join" ||
    normalized.arguments[0]?.getText(sourceFile) !== '"/"'
  )
    return false;
  const split = normalized.expression.expression;
  if (
    !ts.isCallExpression(split) ||
    !ts.isPropertyAccessExpression(split.expression) ||
    split.expression.name.text !== "split" ||
    split.arguments[0]?.getText(sourceFile) !== "NodePath.sep"
  )
    return false;
  const relative = split.expression.expression;
  if (!ts.isCallExpression(relative) || !ts.isPropertyAccessExpression(relative.expression))
    return false;
  if (
    relative.expression.expression.getText(sourceFile) !== "NodePath" ||
    relative.expression.name.text !== "relative" ||
    !isInputField(relative.arguments[0], "workerDir")
  )
    return false;
  const joined = relative.arguments[1];
  if (
    !ts.isCallExpression(joined) ||
    !ts.isPropertyAccessExpression(joined.expression) ||
    joined.expression.expression.getText(sourceFile) !== "NodePath" ||
    joined.expression.name.text !== "join" ||
    !isInputField(joined.arguments[0], "cloudRoot") ||
    !ts.isIdentifier(joined.arguments[1]) ||
    joined.arguments[1].text !== "path"
  )
    return false;
  const returned = firstReturn(sourceFunction);
  if (!ts.isConditionalExpression(returned)) return false;
  const condition = returned.condition;
  if (
    !ts.isCallExpression(condition) ||
    !ts.isPropertyAccessExpression(condition.expression) ||
    !ts.isIdentifier(condition.expression.expression) ||
    condition.expression.expression.text !== "relative" ||
    condition.expression.name.text !== "startsWith" ||
    !ts.isStringLiteralLike(condition.arguments[0]) ||
    condition.arguments[0].text !== "." ||
    !ts.isIdentifier(returned.whenTrue) ||
    returned.whenTrue.text !== "relative"
  )
    return false;
  return (
    ts.isTemplateExpression(returned.whenFalse) &&
    returned.whenFalse.head.text === "./" &&
    ts.isIdentifier(returned.whenFalse.templateSpans[0]?.expression) &&
    returned.whenFalse.templateSpans[0].expression.text === "relative"
  );
}

function interpolatedTarget(expression, template, context) {
  const sourceFile = template.sourceFile;
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return { specifier: expression.text };
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression))
    return undefined;
  if (
    expression.expression.expression.getText(sourceFile) !== "JSON" ||
    expression.expression.name.text !== "stringify"
  )
    return undefined;
  const value = expression.arguments[0];
  if (value === undefined) return undefined;
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "source"
  ) {
    const relativePath = value.arguments[0];
    if (
      !ts.isStringLiteralLike(relativePath) ||
      relativePath.text !== "src/FixtureWorkerExports.ts"
    )
      return undefined;
    const sourceFunction = findFunction(sourceFile, "source");
    if (!sourceFunctionMapsPathToCloudRoot(sourceFunction, sourceFile)) return undefined;
    const invocation = template.invocation;
    const options = invocation?.expression.arguments[0];
    const cloudRoot = propertyValue(namedProperty(options, "cloudRoot"));
    const workerDir = propertyValue(namedProperty(options, "workerDir"));
    const invocationSource = invocation?.sourceFile;
    if (cloudRoot === undefined || workerDir === undefined || invocationSource === undefined)
      return undefined;
    const actualCloudRoot = staticDirectory({
      expression: cloudRoot,
      sourceFile: invocationSource,
    });
    const actualWorkerDir = staticDirectory({
      expression: workerDir,
      sourceFile: invocationSource,
    });
    const mainDirectory = staticDirectory(template.baseLocation);
    if (
      actualCloudRoot !== context.cloudRoot ||
      actualWorkerDir === undefined ||
      actualWorkerDir !== mainDirectory
    )
      return undefined;
    return { absolutePath: NodePath.resolve(actualCloudRoot, relativePath.text) };
  }
  if (!ts.isIdentifier(value)) return undefined;
  const initializer = findVariable(sourceFile, value.text)?.initializer;
  if (initializer === undefined) return undefined;
  if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression))
    return undefined;
  if (
    initializer.expression.expression.getText(sourceFile) !== "NodeURL" ||
    initializer.expression.name.text !== "fileURLToPath"
  )
    return undefined;
  const url = initializer.arguments[0];
  if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression) || url.expression.text !== "URL")
    return undefined;
  const relativePath = url.arguments?.[0];
  const base = url.arguments?.[1];
  if (
    !ts.isStringLiteralLike(relativePath) ||
    !ts.isPropertyAccessExpression(base) ||
    base.getText(sourceFile) !== "import.meta.url"
  )
    return undefined;
  return {
    absolutePath: NodePath.resolve(NodePath.dirname(sourceFile.fileName), relativePath.text),
  };
}

function generatedSourceText(template, context) {
  const node = template.node;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { text: node.text, targets: [] };
  if (!ts.isTemplateExpression(node)) return undefined;
  let text = node.head.text;
  const targets = [];
  for (const span of node.templateSpans) {
    if (/export\s*\*\s*from\s*$/.test(text)) {
      const target = interpolatedTarget(span.expression, template, context);
      if (target?.specifier !== undefined) {
        targets.push(target);
        text += JSON.stringify(target.specifier);
      } else if (target?.absolutePath !== undefined) {
        targets.push(target);
        text += JSON.stringify(target.absolutePath);
      } else text += "null";
    } else text += "null";
    text += span.literal.text;
  }
  return { text, targets };
}

async function targetReachesShared(target, template, candidates, context) {
  const basePath = staticDirectory(template.baseLocation);
  if (NodePath.isAbsolute(target)) return context.reachesSharedExports(NodePath.resolve(target));
  if (basePath === undefined)
    return preparedModuleReachesShared(target, template, candidates, context);
  const path = NodePath.resolve(basePath, target);
  if (await context.reachesSharedExports(path)) return true;
  return path.endsWith(".js") && context.reachesSharedExports(`${path.slice(0, -3)}.ts`);
}

export async function generatedMainReachesShared(generated, candidates, context) {
  const root = candidates.find(
    ({ filePath }) => NodePath.resolve(filePath) === NodePath.resolve(generated.filePath),
  );
  if (root === undefined) return false;
  const candidatesForMain = mainSourceTemplates(root.sourceFile, generated.main, candidates);
  const unique = new Map(
    candidatesForMain.map((template) => [
      `${template.sourceFile.fileName}:${template.node.pos}:${template.node.end}`,
      template,
    ]),
  );
  if (unique.size !== 1) return false;
  const templates = [...unique.values()];
  for (const template of templates) {
    const generatedSource = generatedSourceText(template, context);
    if (generatedSource === undefined) continue;
    const parsed = ts.createSourceFile(
      template.sourceFile.fileName,
      generatedSource.text,
      ts.ScriptTarget.Latest,
      true,
    );
    if (parsed.parseDiagnostics.length > 0) continue;
    const targets = context.exportStars(parsed);
    for (const target of targets) {
      const interpolated = generatedSource.targets.find(
        (value) => value.specifier === target || value.absolutePath === target,
      );
      if (interpolated?.absolutePath === context.sharedExports) return true;
      if (await targetReachesShared(target, template, candidates, context)) return true;
    }
  }
  return false;
}

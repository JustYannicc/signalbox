import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { generatedMainReachesShared } from "./check-cloud-fixture-worker-exports.generated.mjs";

const rootFlag = process.argv.indexOf("--root");
const suppliedRoot = rootFlag < 0 ? undefined : process.argv[rootFlag + 1];
if (rootFlag >= 0 && suppliedRoot === undefined) throw new Error("--root requires a worktree path");
const worktreeRoot = NodePath.resolve(suppliedRoot ?? NodePath.resolve(import.meta.dirname, ".."));
const cloudRoot = NodePath.join(worktreeRoot, "apps/cloud");
const sharedExports = NodePath.join(cloudRoot, "src/FixtureWorkerExports.ts");
const roots = new Map();
const generatedRoots = [];
const failures = [];

async function filesUnder(directory) {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(fullPath);
      return [fullPath];
    }),
  );
  return nested.flat();
}

function parseSource(filePath, source) {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function propertyName(property) {
  if (!ts.isPropertyAssignment(property)) return undefined;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : undefined;
}

function stringValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function urlPath(node) {
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "URL"
  )
    return stringValue(node.arguments?.[0]);
  if (ts.isCallExpression(node)) {
    for (const argument of node.arguments) {
      const found = urlPath(argument);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function mainSource(node) {
  const literal = stringValue(node);
  if (literal !== undefined) return { kind: "path", value: literal };
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  )
    return mainSource(node.left) ?? mainSource(node.right);
  const url = urlPath(node);
  if (url !== undefined) return { kind: "url", value: url };
  return undefined;
}

function literalText(node, values = []) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    values.push(node.text);
  else if (ts.isTemplateExpression(node)) {
    values.push(node.head.text);
    for (const span of node.templateSpans) values.push(span.literal.text);
  }
  ts.forEachChild(node, (child) => {
    literalText(child, values);
  });
  return values;
}

function isWorkerConfig(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const names = new Set(node.properties.map(propertyName).filter(Boolean));
  return (
    names.has("main") &&
    [
      "compatibility_date",
      "compatibility_flags",
      "durable_objects",
      "worker_loaders",
      "no_bundle",
    ].some((name) => names.has(name))
  );
}

function addRoot(filePath, origin) {
  const resolved = NodePath.resolve(filePath);
  const previous = roots.get(resolved);
  roots.set(resolved, previous === undefined ? origin : `${previous}, ${origin}`);
}

async function resolveTestMain(filePath, main, origin) {
  if (main.kind === "url") {
    const resolved = NodePath.resolve(NodePath.dirname(filePath), main.value);
    addRoot(resolved, origin);
    return;
  }

  const resolved = NodePath.resolve(NodePath.dirname(filePath), main.value);
  if ((await NodeFSP.stat(resolved).catch(() => undefined))?.isFile()) {
    addRoot(resolved, origin);
    return;
  }
  generatedRoots.push({ filePath, main: main.value, origin });
}

function collectConfigMains(sourceFile) {
  const mains = [];
  const visit = (node) => {
    if (isWorkerConfig(node)) {
      const main = node.properties.find((property) => propertyName(property) === "main");
      const value = mainSource(main.initializer);
      if (value !== undefined) mains.push(value);
      else
        failures.push(
          `${sourceFile.fileName}: cannot resolve fixture Worker main ${main.initializer.getText(sourceFile)}`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mains;
}

function collectHarnessMainOverrides(sourceFile) {
  const mains = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^create.*Harness$/.test(node.expression.text) &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const main = node.arguments[0].properties.find(
        (property) => propertyName(property) === "main",
      );
      if (main !== undefined && ts.isPropertyAssignment(main)) {
        const value = mainSource(main.initializer);
        if (value !== undefined) mains.push(value);
        else
          failures.push(
            `${sourceFile.fileName}: cannot resolve fixture Worker main override ${main.initializer.getText(sourceFile)}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mains;
}

function exportStars(sourceFile) {
  const stars = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause === undefined &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      stars.push(statement.moduleSpecifier.text);
  }
  return stars;
}

async function reachesSharedExports(filePath, visited = new Set()) {
  const resolved = NodePath.resolve(filePath);
  if (resolved === sharedExports) return true;
  if (visited.has(resolved)) return false;
  visited.add(resolved);
  const source = await NodeFSP.readFile(resolved, "utf8").catch(() => undefined);
  if (source === undefined) return false;
  const sourceFile = parseSource(resolved, source);
  for (const specifier of exportStars(sourceFile)) {
    const target = NodePath.resolve(NodePath.dirname(resolved), specifier);
    const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`];
    for (const candidate of candidates) {
      if ((await NodeFSP.stat(candidate).catch(() => undefined))?.isFile()) {
        if (await reachesSharedExports(candidate, visited)) return true;
      }
    }
  }
  return false;
}

async function findGeneratedSources(filePath, visited = new Set()) {
  const resolved = NodePath.resolve(filePath);
  if (visited.has(resolved)) return [];
  visited.add(resolved);
  const source = await NodeFSP.readFile(resolved, "utf8").catch(() => undefined);
  if (source === undefined) return [];
  const sourceFile = parseSource(resolved, source);
  const result = [{ filePath: resolved, source, sourceFile }];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const base = NodePath.resolve(NodePath.dirname(resolved), specifier);
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`];
    for (const candidate of candidates) {
      if (!candidate.startsWith(cloudRoot + NodePath.sep)) continue;
      if ((await NodeFSP.stat(candidate).catch(() => undefined))?.isFile()) {
        result.push(...(await findGeneratedSources(candidate, visited)));
        break;
      }
    }
  }
  return result;
}

async function sourceForWranglerMain(configPath, main) {
  const mainPath = NodePath.resolve(NodePath.dirname(configPath), main);
  const stem = NodePath.basename(mainPath, NodePath.extname(mainPath));
  if (stem === "worker") {
    const candidates = [
      NodePath.join(NodePath.dirname(mainPath), "worker.ts"),
      NodePath.join(NodePath.dirname(configPath), "worker.ts"),
      NodePath.join(NodePath.dirname(configPath), "proof.ts"),
    ];
    for (const candidate of candidates)
      if ((await NodeFSP.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  if ((await NodeFSP.stat(mainPath).catch(() => undefined))?.isFile()) return mainPath;
  const sibling = NodePath.join(NodePath.dirname(configPath), `${stem}.ts`);
  if ((await NodeFSP.stat(sibling).catch(() => undefined))?.isFile()) return sibling;
  return undefined;
}

const sourceFiles = (await filesUnder(NodePath.join(cloudRoot, "src"))).concat(
  await filesUnder(NodePath.join(cloudRoot, "infra")),
);
const moduleFiles = sourceFiles.filter((filePath) => /\.(?:ts|tsx|js|mjs)$/.test(filePath));

// WorkerLoader facets and release entrypoints are not main workers, so only main config roots enter this set.
for (const filePath of moduleFiles) {
  const source = await NodeFSP.readFile(filePath, "utf8");
  const sourceFile = parseSource(filePath, source);
  if (source.includes("createTestHarness")) {
    for (const main of collectConfigMains(sourceFile))
      await resolveTestMain(filePath, main, "createTestHarness");
  }
  for (const main of collectHarnessMainOverrides(sourceFile))
    await resolveTestMain(filePath, main, "harness main override");
}

for (const filePath of sourceFiles.filter((file) => file.endsWith(".jsonc"))) {
  if (!filePath.includes(`${NodePath.sep}infra${NodePath.sep}`)) continue;
  const parsed = ts.parseConfigFileTextToJson(filePath, await NodeFSP.readFile(filePath, "utf8"));
  const main = parsed.config?.main;
  if (typeof main !== "string") continue;
  const source = await sourceForWranglerMain(filePath, main);
  if (source === undefined) {
    failures.push(
      `${NodePath.relative(worktreeRoot, filePath)}: cannot map main ${main} to source`,
    );
    continue;
  }
  addRoot(source, `Wrangler main ${main}`);
}

for (const filePath of moduleFiles.filter((file) => file.endsWith("PrepareWorker.ts"))) {
  if (!filePath.includes(`${NodePath.sep}infra${NodePath.sep}`)) continue;
  const source = await NodeFSP.readFile(filePath, "utf8");
  const sourceFile = parseSource(filePath, source);
  const visit = (node) => {
    if (propertyName(node) === "entryPoints" && ts.isPropertyAssignment(node)) {
      for (const value of literalText(node.initializer)) {
        if (!/(?:^|\/)worker(?:\.worker)?\.ts$/.test(value)) continue;
        const candidate = NodePath.resolve(NodePath.dirname(filePath), value);
        if (NodePath.basename(candidate) === "worker.ts" || candidate.endsWith(".worker.ts")) {
          addRoot(candidate, `esbuild main from ${NodePath.relative(worktreeRoot, filePath)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const isolateProbePrepare = NodePath.join(cloudRoot, "infra/isolateProbe/prepare.ts");
const isolateProbePrepareSource = parseSource(
  isolateProbePrepare,
  await NodeFSP.readFile(isolateProbePrepare, "utf8"),
);
const isolateProbePrepareLiterals = literalText(isolateProbePrepareSource);
if (
  !isolateProbePrepareLiterals.includes("../../src/FixtureWorkerExports.ts") ||
  !isolateProbePrepareLiterals.includes("FixtureWorkerExports.js")
)
  failures.push("apps/cloud/infra/isolateProbe/prepare.ts does not bundle the shared root exports");

for (const filePath of moduleFiles.filter((file) => /\.alchemy\.ts$|\.run\.ts$/.test(file))) {
  if (!filePath.includes(`${NodePath.sep}infra${NodePath.sep}`)) continue;
  if (!/(?:proof|probe|spike)/i.test(filePath)) continue;
  const source = await NodeFSP.readFile(filePath, "utf8");
  const sourceFile = parseSource(filePath, source);
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "Worker"
    ) {
      const config = node.arguments[1];
      if (ts.isObjectLiteralExpression(config)) {
        const main = config.properties.find((property) => propertyName(property) === "main");
        if (main !== undefined && ts.isPropertyAssignment(main)) {
          for (const value of literalText(main.initializer)) {
            if (!value.endsWith(".ts")) continue;
            const relativePath = value.match(/(?:\.\.\/|\.\/)[^\s"'`]+\.ts$/)?.[0] ?? value;
            const candidate = NodePath.resolve(NodePath.dirname(filePath), relativePath);
            addRoot(
              candidate,
              `Alchemy Worker main from ${NodePath.relative(worktreeRoot, filePath)}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const sharedSource = parseSource(sharedExports, await NodeFSP.readFile(sharedExports, "utf8"));
if (!exportStars(sharedSource).includes("./worker.ts"))
  failures.push("apps/cloud/src/FixtureWorkerExports.ts must re-export apps/cloud/src/worker.ts");

if (roots.size === 0 && generatedRoots.length === 0)
  failures.push("No Cloud test Worker roots were discovered from their main configs");

for (const rootPath of roots.keys()) {
  if (!(await reachesSharedExports(rootPath)))
    failures.push(
      `${NodePath.relative(worktreeRoot, rootPath)} does not re-export FixtureWorkerExports`,
    );
}

for (const generated of generatedRoots) {
  const candidates = await findGeneratedSources(generated.filePath);
  const exported = await generatedMainReachesShared(generated, candidates, {
    cloudRoot,
    worktreeRoot,
    sharedExports,
    exportStars,
    reachesSharedExports,
  });
  if (!exported) {
    failures.push(
      `${NodePath.relative(worktreeRoot, generated.filePath)} (${generated.main}, ${generated.origin}) has no production export in its generated Worker source`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(
    `Cloud fixture Worker export check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}

process.stdout.write(
  `Cloud fixture Worker exports reach ${roots.size} checked-in roots and ${generatedRoots.length} generated roots.\n`,
);

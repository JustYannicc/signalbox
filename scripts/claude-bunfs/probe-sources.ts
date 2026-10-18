// @effect-diagnostics nodeBuiltinImport:off - validates extracted source fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import TypeScript from "typescript-legacy";
import { decodeModule } from "./bun-graph.ts";
export const binarySha256 = "60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5";
export const probeModule = "__signalbox_probe__/entry.js";
const jsLoader = 1;
export type Encoding = "latin1" | "utf8" | "utf16le";
type ModuleEncoding = 0 | 1 | 2;
type SourceManifest = {
  binary?: { sha256?: unknown };
  graph: { entry: number };
  modules: {
    index: number;
    name: string;
    encoding: unknown;
    loader: number;
    artifacts: Record<string, unknown>;
  }[];
};
export type SourceModule = {
  name: string;
  path: string;
  encoding: Encoding;
  source: string;
  bytes: Uint8Array;
  sha256: string;
};

export function digest(bytes: Uint8Array) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeEncoding(value: unknown): ModuleEncoding {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new Error(`Unsupported module encoding: ${String(value)}`);
}

function encodingName(encoding: ModuleEncoding): Encoding {
  switch (encoding) {
    case 0:
      return "utf8";
    case 1:
      return "latin1";
    case 2:
      return "utf16le";
  }
}

function safeSourcePath(root: string, relativePath: string) {
  const resolvedRoot = NodePath.resolve(root);
  const resolved = NodePath.resolve(resolvedRoot, relativePath);
  const relative = NodePath.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new Error(`Manifest source path escapes input directory: ${relativePath}`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManifest(value: unknown): SourceManifest {
  if (
    !isRecord(value) ||
    !isRecord(value.graph) ||
    !Number.isSafeInteger(value.graph.entry) ||
    !Array.isArray(value.modules) ||
    !value.modules.every(
      (module) =>
        isRecord(module) &&
        Number.isSafeInteger(module.index) &&
        typeof module.name === "string" &&
        typeof module.loader === "number" &&
        isRecord(module.artifacts),
    )
  )
    throw new Error("Invalid extraction manifest");
  return value as unknown as SourceManifest;
}

async function readManifest(path: string) {
  try {
    return parseManifest(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT")
      throw new Error(`Extraction manifest not found: ${path}`, { cause: error });
    throw error;
  }
}

async function readSources(root: string, manifest: SourceManifest): Promise<SourceModule[]> {
  const modules: SourceModule[] = [];
  const pin = manifest.binary?.sha256;
  if (pin && pin !== binarySha256)
    throw new Error(`Manifest binary hash does not match Claude 2.1.302: ${String(pin)}`);
  for (const record of manifest.modules) {
    if (record.loader !== jsLoader) continue;
    const contents = record.artifacts.contents;
    if (!isRecord(contents) || typeof contents.path !== "string" || !contents.path)
      throw new Error(`Manifest has no contents path for ${record.name}`);
    if (typeof contents.sha256 !== "string")
      throw new Error(`Manifest has no contents hash for ${record.name}`);
    const bytes = await NodeFSP.readFile(safeSourcePath(root, contents.path));
    const sha256 = digest(bytes);
    if (sha256 !== contents.sha256)
      throw new Error(`Source hash differs from the extraction manifest: ${record.name}`);
    const encoding = normalizeEncoding(record.encoding);
    modules.push({
      name: record.name,
      path: contents.path,
      encoding: encodingName(encoding),
      bytes,
      source: decodeModule(bytes, encoding),
      sha256,
    });
  }

  if (!modules.length) throw new Error("No JavaScript source modules found in extraction manifest");
  if (modules.some((module) => module.name === probeModule))
    throw new Error(`Source module collides with ${probeModule}`);
  return modules.sort(
    (a, b) =>
      b.bytes.byteLength - a.bytes.byteLength || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export async function reachableSources(root: string, manifestPath: string, output: string) {
  const manifest = await readManifest(manifestPath);
  const sources = await readSources(root, manifest);
  const byName = new Map(sources.map((module) => [module.name, module]));
  const entry = manifest.modules.find((module) => module.index === manifest.graph.entry);
  if (!entry || !byName.has(entry.name))
    throw new Error("Manifest entry is not a JavaScript source module");
  const pending = [entry.name];
  const reachable = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const module = byName.get(name)!;
    const ast = TypeScript.createSourceFile(
      name,
      module.source,
      TypeScript.ScriptTarget.Latest,
      false,
      TypeScript.ScriptKind.JS,
    );
    if (
      !("parseDiagnostics" in ast) ||
      !Array.isArray(ast.parseDiagnostics) ||
      ast.parseDiagnostics.length
    )
      throw new Error(`Invalid JavaScript source module: ${name}`);
    const visit = (node: TypeScript.Node) => {
      let specifier: string | undefined;
      if (
        (TypeScript.isImportDeclaration(node) || TypeScript.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        TypeScript.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        TypeScript.isCallExpression(node) &&
        node.arguments[0] &&
        TypeScript.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === TypeScript.SyntaxKind.ImportKeyword ||
          (TypeScript.isIdentifier(node.expression) && node.expression.text === "require") ||
          (TypeScript.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "require"))
      )
        specifier = node.arguments[0].text;
      if (specifier) {
        const dependency = specifier.startsWith(".")
          ? NodePath.posix.resolve(NodePath.posix.dirname(name), specifier)
          : specifier;
        if (byName.has(dependency) && !reachable.has(dependency)) pending.push(dependency);
      }
      TypeScript.forEachChild(node, visit);
    };
    visit(ast);
  }
  const excluded = manifest.modules
    .filter((module) => module.loader !== jsLoader)
    .map((module) => ({
      index: module.index,
      name: module.name,
      loader: module.loader,
      artifacts: module.artifacts,
    }));
  const bytecode = manifest.modules
    .filter((module) => module.artifacts.bytecode)
    .map((module) => ({
      index: module.index,
      name: module.name,
      artifact: module.artifacts.bytecode,
    }));
  await NodeFSP.mkdir(output, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(output, "probe-module-inventory.json"),
    JSON.stringify(
      { entry: entry.name, reachableSourceModules: [...reachable], excluded, bytecode },
      null,
      2,
    ),
  );
  return sources.filter((module) => reachable.has(module.name));
}

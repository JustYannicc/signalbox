// @effect-diagnostics nodeBuiltinImport:off - validates extracted source fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import TypeScript from "typescript-legacy";
export const binarySha256 = "60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5";
export const probeModule = "__signalbox_probe__/entry.js";
export type Encoding = "latin1" | "utf8" | "utf16le";
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

function normalizeEncoding(value: unknown): Encoding {
  if (value === 1 || value === "latin1" || value === "latin-1" || value === "iso-8859-1")
    return "latin1";
  if (value === 2 || value === "utf16le" || value === "utf-16le") return "utf16le";
  if (value === 0 || value === "utf8" || value === "utf-8" || value === undefined || value === null)
    return "utf8";
  throw new Error(`Unsupported module encoding: ${String(value)}`);
}

function decode(bytes: Uint8Array, encoding: Encoding) {
  if (encoding === "latin1") {
    let source = "";
    for (let at = 0; at < bytes.length; at += 8192) {
      source += String.fromCharCode(...bytes.subarray(at, at + 8192));
    }
    return source;
  }
  return new TextDecoder(encoding === "utf16le" ? "utf-16le" : "utf-8", { fatal: true }).decode(
    bytes,
  );
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

function manifestRows(value: unknown): Array<[string | undefined, Record<string, unknown>]> {
  if (!value || typeof value !== "object") throw new Error("Invalid source manifest");
  const modules = (value as { modules?: unknown }).modules;
  if (Array.isArray(modules)) {
    return modules.map((module) => [undefined, module as Record<string, unknown>]);
  }
  if (modules && typeof modules === "object") {
    return Object.entries(modules as Record<string, Record<string, unknown>>);
  }
  throw new Error("Source manifest has no modules");
}

async function readSources(
  root: string,
  manifestPath: string | undefined,
): Promise<SourceModule[]> {
  const modules: SourceModule[] = [];
  if (manifestPath) {
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const pin = (manifest.binary as { sha256?: unknown } | undefined)?.sha256;
    if (pin && pin !== binarySha256)
      throw new Error(`Manifest binary hash does not match Claude 2.1.302: ${String(pin)}`);
    for (const [key, record] of manifestRows(manifest)) {
      const name = String(record.name ?? key ?? "");
      if (record.loader !== 1) continue;
      const contents =
        record.artifacts && typeof record.artifacts === "object"
          ? (record.artifacts as Record<string, Record<string, unknown>>).contents
          : undefined;
      const relativePath = String(contents?.path ?? record.path ?? "");
      if (!relativePath) throw new Error(`Manifest has no contents path for ${name}`);
      const bytes = await NodeFSP.readFile(safeSourcePath(root, relativePath));
      if (typeof contents?.sha256 !== "string" || digest(bytes) !== contents.sha256)
        throw new Error(`Source hash differs from the extraction manifest: ${name}`);
      const encoding = normalizeEncoding(record.encoding ?? contents?.encoding ?? 1);
      modules.push({
        name,
        path: relativePath,
        encoding,
        bytes,
        source: decode(bytes, encoding),
        sha256: digest(bytes),
      });
    }
  }

  if (!modules.length) throw new Error(`No .js or .mjs source modules found below ${root}`);
  if (modules.some((module) => module.name === probeModule))
    throw new Error(`Source module collides with ${probeModule}`);
  return modules.sort(
    (a, b) =>
      b.bytes.byteLength - a.bytes.byteLength || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export async function reachableSources(root: string, manifestPath: string, output: string) {
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
    graph: { entry: number };
    modules: {
      index: number;
      name: string;
      loader: number;
      artifacts: Record<string, { path: string; bytes: number; sha256: string }>;
    }[];
  };
  const sources = await readSources(root, manifestPath);
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
    .filter((module) => module.loader !== 1)
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

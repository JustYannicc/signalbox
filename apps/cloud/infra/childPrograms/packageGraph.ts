// @effect-diagnostics nodeBuiltinImport:off - packages verified local child sources.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";

export interface ChildProgramSourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type ChildProgramSourceCode = Omit<ChildWorkerCode, "modules"> & {
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
};

const IMPORT_PATTERN = /\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g;

interface ProgramGraph {
  readonly entrypoint: string;
  readonly code: ChildProgramSourceCode;
}

export async function packageGraph(
  cloudRoot: string,
  entrySource: string,
  entrypoint: string,
  mainSource: (entrypoint: string) => string,
  sources: Map<string, ChildProgramSourceRecord>,
): Promise<ProgramGraph> {
  const pending = [entrySource];
  const modules = new Map<string, string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (modules.has(sourcePath)) continue;
    assertKernelSourcePath(sourcePath);
    const absolutePath = NodePath.resolve(cloudRoot, sourcePath);
    if (!absolutePath.startsWith(cloudRoot + NodePath.sep)) {
      throw new Error(`Child source escapes apps/cloud: ${sourcePath}`);
    }
    const sourceBytes = await NodeFSP.readFile(absolutePath);
    const stripped = NodeModule.stripTypeScriptTypes(sourceBytes.toString("utf8"), {
      mode: "strip",
    });
    for (const specifier of relativeImports(stripped)) {
      if (!specifier.endsWith(".ts")) {
        throw new Error(
          `Child source import must name a TypeScript file: ${sourcePath} -> ${specifier}`,
        );
      }
      const dependency = NodePath.posix.normalize(
        NodePath.posix.join(NodePath.posix.dirname(sourcePath), specifier),
      );
      assertKernelSourcePath(dependency);
      pending.push(dependency);
    }
    const javascript = rewriteTypeScriptImports(stripped);
    modules.set(sourcePath, javascript);
    addRecord(sources, sourcePath, sourceBytes);
    addGeneratedRecord(
      sources,
      `generated/${entrypoint}/${javascriptPath(sourcePath)}`,
      javascript,
    );
  }

  const generatedMain = mainSource(entrypoint);
  const moduleSources = Object.fromEntries(
    [...modules].map(([sourcePath, javascript]) => [
      javascriptPath(sourcePath),
      { js: javascript },
    ]),
  );
  const code: ChildProgramSourceCode = Object.freeze({
    mainModule: "main.js",
    entrypoint,
    modules: Object.freeze({
      "main.js": Object.freeze({ js: generatedMain }),
      ...moduleSources,
    }),
  });
  addGeneratedRecord(sources, `generated/${entrypoint}/main.js`, generatedMain);
  return { entrypoint, code };
}

function relativeImports(source: string): readonly string[] {
  const imports = new Set<string>();
  for (const match of source.matchAll(IMPORT_PATTERN)) imports.add(match[1]!);
  return [...imports];
}

function rewriteTypeScriptImports(source: string): string {
  return source.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1");
}

function assertKernelSourcePath(sourcePath: string): void {
  if (!/^src\/(?:computer|kernel)\//.test(sourcePath) || sourcePath.split("/").includes("..")) {
    throw new Error(`Child source is outside the computer and kernel modules: ${sourcePath}`);
  }
}

export async function recordFile(
  cloudRoot: string,
  relativePath: string,
  inventory: Map<string, ChildProgramSourceRecord>,
): Promise<void> {
  const bytes = await NodeFSP.readFile(NodePath.join(cloudRoot, relativePath));
  addRecord(inventory, relativePath, bytes);
}

function addRecord(
  inventory: Map<string, ChildProgramSourceRecord>,
  path: string,
  bytes: Uint8Array,
): void {
  inventory.set(path, { path, bytes: bytes.byteLength, sha256: digest(bytes) });
}

function addGeneratedRecord(
  inventory: Map<string, ChildProgramSourceRecord>,
  path: string,
  source: string,
): void {
  const bytes = new TextEncoder().encode(source);
  addRecord(inventory, path, bytes);
}

export function programInventory(graph: ProgramGraph) {
  return Object.freeze({
    entrypoint: graph.entrypoint,
    mainModule: graph.code.mainModule,
    modules: Object.freeze(Object.keys(graph.code.modules).sort()),
  });
}

function javascriptPath(sourcePath: string): string {
  return sourcePath.replace(/\.ts$/, ".js");
}

export function byPath(left: ChildProgramSourceRecord, right: ChildProgramSourceRecord): number {
  return left.path.localeCompare(right.path);
}

export function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

// @effect-diagnostics nodeBuiltinImport:off - this file packages local proof artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";

const ARTIFACTS = Object.freeze({
  bash: Object.freeze({
    file: "bash.wasm",
    bytes: 3_887_571,
    sha256: "17caf644602115465f3ef02204e2f67917bfe58d6089c10f77f94863e4c3bd87",
  }),
  busybox: Object.freeze({
    file: "busybox.wasm",
    bytes: 241_159,
    sha256: "7d1b34a31d74473be1fdb50706ed75e8ec765b68878b4fb2cf6ab486cbcb2631",
  }),
  ripgrep: Object.freeze({
    file: "rg.wasm",
    bytes: 2_208_556,
    sha256: "791b862a433f1a5a9b6a7ce982546d33f4146dcb019dba5da1e78be7bffc7ca7",
  }),
});

const SOURCE_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const IMPORT_PATTERN = /\b(?:from\s*|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g;

export interface HookChildSourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface HookChildSourceInventory {
  readonly format: "signalbox-hook-child-programs-v1";
  readonly sources: readonly HookChildSourceRecord[];
  readonly artifacts: readonly HookChildSourceRecord[];
  readonly programs: Readonly<
    Record<
      "bash" | "busyboxCat" | "ripgrep",
      {
        readonly entrypoint: string;
        readonly mainModule: string;
        readonly modules: readonly string[];
      }
    >
  >;
}

export type HookChildWorkerCode = Omit<ChildWorkerCode, "modules"> & {
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
};

export interface HookChildProgramSources {
  readonly bash: HookChildWorkerCode;
  readonly busyboxCat: HookChildWorkerCode;
  readonly ripgrep: HookChildWorkerCode;
}

export type HookChildExecutablePath = "/bin/bash" | "/bin/cat" | "/bin/rg";

export interface HookChildExecutableFile {
  readonly path: HookChildExecutablePath;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export type HookChildExecutableCatalog = Readonly<
  Record<HookChildExecutablePath, { readonly bytes: number; readonly sha256: string }>
>;

export interface PreparedHookChildPrograms extends HookChildProgramSources {
  readonly executableFiles: readonly HookChildExecutableFile[];
  readonly executableCatalog: HookChildExecutableCatalog;
  readonly sourceInventory: HookChildSourceInventory;
}

export interface PrepareHookChildProgramsOptions {
  readonly programDir: string;
  readonly cloudRoot?: string;
}

/** Builds static Dynamic Worker modules and returns verified WASM bytes for the seed bundle. */
export async function prepareHookChildPrograms(
  options: PrepareHookChildProgramsOptions,
): Promise<PreparedHookChildPrograms> {
  if (options == null) throw new Error("Pass the pinned program directory");
  const programDir = NodePath.resolve(options.programDir);
  const cloudRoot = await NodeFSP.realpath(options.cloudRoot ?? SOURCE_ROOT);
  const sources = new Map<string, HookChildSourceRecord>();
  const artifacts = new Map<string, HookChildSourceRecord>();

  const [bashArtifact, busyboxArtifact, ripgrepArtifact] = await Promise.all([
    readArtifact(programDir, ARTIFACTS.bash, artifacts),
    readArtifact(programDir, ARTIFACTS.busybox, artifacts),
    readArtifact(programDir, ARTIFACTS.ripgrep, artifacts),
  ]);
  const [bashGraph, busyboxGraph, ripgrepGraph] = await Promise.all([
    packageGraph(cloudRoot, "src/computer/ChildBash.ts", "ChildBash", bashMain, sources),
    packageGraph(cloudRoot, "src/computer/ChildBusybox.ts", "ChildBusybox", busyboxMain, sources),
    packageGraph(cloudRoot, "src/computer/ChildWasi.ts", "ChildRipgrep", ripgrepMain, sources),
  ]);

  for (const relativePath of [
    "infra/hooksProof/preparePrograms.ts",
    "infra/hooksProof/childPrograms.ts",
  ]) {
    await recordFile(cloudRoot, relativePath, sources);
  }

  const inventory: HookChildSourceInventory = Object.freeze({
    format: "signalbox-hook-child-programs-v1",
    sources: Object.freeze([...sources.values()].sort(byPath)),
    artifacts: Object.freeze([...artifacts.values()].sort(byPath)),
    programs: Object.freeze({
      bash: programInventory(bashGraph),
      busyboxCat: programInventory(busyboxGraph),
      ripgrep: programInventory(ripgrepGraph),
    }),
  });
  const executableFiles = Object.freeze([
    Object.freeze({ path: "/bin/bash" as const, ...bashArtifact }),
    Object.freeze({ path: "/bin/cat" as const, ...busyboxArtifact }),
    Object.freeze({ path: "/bin/rg" as const, ...ripgrepArtifact }),
  ]);
  const executableCatalog: HookChildExecutableCatalog = Object.freeze({
    "/bin/bash": Object.freeze({
      bytes: bashArtifact.bytes.byteLength,
      sha256: bashArtifact.sha256,
    }),
    "/bin/cat": Object.freeze({
      bytes: busyboxArtifact.bytes.byteLength,
      sha256: busyboxArtifact.sha256,
    }),
    "/bin/rg": Object.freeze({
      bytes: ripgrepArtifact.bytes.byteLength,
      sha256: ripgrepArtifact.sha256,
    }),
  });
  return Object.freeze({
    bash: bashGraph.code,
    busyboxCat: busyboxGraph.code,
    ripgrep: ripgrepGraph.code,
    executableFiles,
    executableCatalog,
    sourceInventory: inventory,
  });
}

interface ProgramGraph {
  readonly entrypoint: string;
  readonly code: HookChildWorkerCode;
}

async function packageGraph(
  cloudRoot: string,
  entrySource: string,
  entrypoint: string,
  mainSource: (entrypoint: string) => string,
  sources: Map<string, HookChildSourceRecord>,
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
  const code: HookChildWorkerCode = Object.freeze({
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

async function readArtifact(
  programDir: string,
  artifact: (typeof ARTIFACTS)[keyof typeof ARTIFACTS],
  inventory: Map<string, HookChildSourceRecord>,
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const path = NodePath.join(programDir, artifact.file);
  const bytes = await NodeFSP.readFile(path);
  const sha256 = digest(bytes);
  if (bytes.byteLength !== artifact.bytes || sha256 !== artifact.sha256) {
    throw new Error(`Pinned child program does not match ${artifact.file}`);
  }
  inventory.set(artifact.file, { path: artifact.file, bytes: bytes.byteLength, sha256 });
  return { bytes, sha256 };
}

async function recordFile(
  cloudRoot: string,
  relativePath: string,
  inventory: Map<string, HookChildSourceRecord>,
): Promise<void> {
  const bytes = await NodeFSP.readFile(NodePath.join(cloudRoot, relativePath));
  addRecord(inventory, relativePath, bytes);
}

function addRecord(
  inventory: Map<string, HookChildSourceRecord>,
  path: string,
  bytes: Uint8Array,
): void {
  inventory.set(path, { path, bytes: bytes.byteLength, sha256: digest(bytes) });
}

function addGeneratedRecord(
  inventory: Map<string, HookChildSourceRecord>,
  path: string,
  source: string,
): void {
  const bytes = new TextEncoder().encode(source);
  addRecord(inventory, path, bytes);
}

function programInventory(graph: ProgramGraph) {
  return Object.freeze({
    entrypoint: graph.entrypoint,
    mainModule: graph.code.mainModule,
    modules: Object.freeze(Object.keys(graph.code.modules).sort()),
  });
}

function javascriptPath(sourcePath: string): string {
  return sourcePath.replace(/\.ts$/, ".js");
}

function byPath(left: HookChildSourceRecord, right: HookChildSourceRecord): number {
  return left.path.localeCompare(right.path);
}

function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function bashMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createChildBash } from "./src/computer/ChildBash.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    const { pid, credentials } = await owner.metadata();",
    "    const bash = createChildBash({ module, credentials, pid, port: owner, args: command.argv, env: command.env });",
    "    try { return await bash.run(); } finally { await bash.drain(); }",
    "  }",
    "}",
    "",
  ].join("\n");
}

function busyboxMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createChildBusybox } from "./src/computer/ChildBusybox.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    return await createChildBusybox({ module, port: owner, args: command.argv, env: command.env }).run();",
    "  }",
    "}",
    "",
  ].join("\n");
}

function ripgrepMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createChildWasi } from "./src/computer/ChildWasi.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    const wasi = createChildWasi({ module, syscalls: owner, args: command.argv, env: { ...command.env, PWD: command.cwd } });",
    "    const instance = new WebAssembly.Instance(module, wasi.imports);",
    "    wasi.bind(instance);",
    "    return { exitCode: await wasi.start(instance), signal: 0, coreDumped: false };",
    "  }",
    "}",
    "",
  ].join("\n");
}

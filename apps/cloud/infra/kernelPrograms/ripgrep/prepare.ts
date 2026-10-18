// @effect-diagnostics nodeBuiltinImport:off - build-time facet packaging only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { RIPGREP_PROBE_SOURCE } from "./probe-source.ts";

const ARTIFACT = Object.freeze({
  name: "ripgrep",
  version: "15.1.0",
  path: "rg.wasm",
  bytes: 2_208_393,
  sha256: "b88624f67935ecd82f757e29862d01ea5b98935ede62b8f69ba3284b7937a5c5",
});
const IMPORTS = Object.freeze([
  "wasi_snapshot_preview1.args_get",
  "wasi_snapshot_preview1.args_sizes_get",
  "wasi_snapshot_preview1.clock_time_get",
  "wasi_snapshot_preview1.environ_get",
  "wasi_snapshot_preview1.environ_sizes_get",
  "wasi_snapshot_preview1.fd_close",
  "wasi_snapshot_preview1.fd_fdstat_get",
  "wasi_snapshot_preview1.fd_fdstat_set_flags",
  "wasi_snapshot_preview1.fd_filestat_get",
  "wasi_snapshot_preview1.fd_prestat_dir_name",
  "wasi_snapshot_preview1.fd_prestat_get",
  "wasi_snapshot_preview1.fd_readdir",
  "wasi_snapshot_preview1.fd_read",
  "wasi_snapshot_preview1.fd_seek",
  "wasi_snapshot_preview1.fd_write",
  "wasi_snapshot_preview1.path_filestat_get",
  "wasi_snapshot_preview1.path_open",
  "wasi_snapshot_preview1.path_readlink",
  "wasi_snapshot_preview1.poll_oneoff",
  "wasi_snapshot_preview1.proc_exit",
  "wasi_snapshot_preview1.random_get",
  "wasi_snapshot_preview1.sched_yield",
]);
const SOURCE_MARKER = "__RIPGREP_FACET_SOURCE_INVENTORY__";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
type SourceRecord = { readonly path: string; readonly bytes: number; readonly sha256: string };

/** Package the proof with a static WASM import; runtime code never compiles or evaluates bytes. */
export async function prepareKernelRipgrepFacet(
  destination: string,
  ripgrepPath?: string,
  sourceRoot?: string,
  sourceRevision?: string,
) {
  const sourcePath = NodePath.resolve(ripgrepPath ?? NodePath.join(scriptDir, "bin/rg.wasm"));
  const bytes = await NodeFSP.readFile(sourcePath);
  if (bytes.byteLength !== ARTIFACT.bytes || digest(bytes) !== ARTIFACT.sha256) {
    throw new Error("ripgrep artifact does not match its frozen source pin");
  }
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name, kind }) => `${module}.${name}`)
    .sort();
  if (JSON.stringify(imports) !== JSON.stringify([...IMPORTS].sort())) {
    throw new Error("ripgrep WASM import inventory changed");
  }

  const kernelRoot = NodePath.resolve(
    sourceRoot ?? NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const outputDir = NodePath.resolve(destination);
  const copied = new Set<string>();
  const sources = await Promise.all(
    [
      "src/kernel/KernelAbi.ts",
      "src/kernel/FacetSqliteStorage.ts",
      "src/kernel/KernelFileSystem.ts",
      "src/kernel/KernelProgramHost.ts",
      "src/kernel/KernelWakeRegistry.ts",
    ].map((path) => copyKernelModule(path, kernelRoot, outputDir, copied)),
  ).then((records) => records.flat());
  const probeSourceBytes = await NodeFSP.readFile(NodePath.join(scriptDir, "probe-source.ts"));
  const builderBytes = await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url));
  sources.push(
    {
      path: "infra/kernelPrograms/ripgrep/probe-source.ts",
      bytes: probeSourceBytes.byteLength,
      sha256: digest(probeSourceBytes),
    },
    {
      path: "infra/kernelPrograms/ripgrep/prepare.ts",
      bytes: builderBytes.byteLength,
      sha256: digest(builderBytes),
    },
  );
  sources.sort((a, b) => a.path.localeCompare(b.path));

  const marker = JSON.stringify(SOURCE_MARKER);
  if (!RIPGREP_PROBE_SOURCE.includes(marker)) {
    throw new Error("ripgrep proof source lost its inventory marker");
  }
  const main = RIPGREP_PROBE_SOURCE.replace('from "./bin/rg.wasm"', 'from "./rg.wasm"')
    .replaceAll('from "../../../src/kernel/', 'from "./src/kernel/')
    .replace(/(from "\.\/src\/kernel\/[^\"]+)\.ts"/g, '$1.js"')
    .replace(marker, JSON.stringify({ revision: sourceRevision ?? null, files: sources }));
  if (!main.includes('import rg from "./rg.wasm"') || main.includes("WebAssembly.Module(")) {
    throw new Error("ripgrep proof must statically import WASM without runtime compilation");
  }
  await NodeFSP.mkdir(outputDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main);
  await NodeFSP.writeFile(NodePath.join(outputDir, ARTIFACT.path), bytes);

  const modules: Record<string, { path: string; type: "js" | "wasm" }> = {
    "main.js": { path: "main.js", type: "js" },
    "rg.wasm": { path: "rg.wasm", type: "wasm" },
  };
  for (const path of copied) {
    const name = path.replace(/\.ts$/, ".js");
    modules[name] = { path: name, type: "js" };
  }
  const kernelModules = await Promise.all(
    [...copied].sort().map(async (path) => {
      const name = path.replace(/\.ts$/, ".js");
      const output = await NodeFSP.readFile(NodePath.join(outputDir, name));
      return { name, type: "js" as const, bytes: output.byteLength, sha256: digest(output) };
    }),
  );
  const inventory = {
    artifact: ARTIFACT,
    sourceRevision: sourceRevision ?? null,
    wasmImports: imports,
    sources,
    modules: [
      { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
      { name: "rg.wasm", type: "wasm", bytes: bytes.byteLength, sha256: digest(bytes) },
      ...kernelModules,
    ],
  };
  const manifest = {
    id: "kernel-ripgrep-proof-v1",
    sourceRevision: sourceRevision ?? null,
    mainModule: "main.js",
    entrypoint: "ProbeFacet",
    mode: "facet",
    allowOutbound: false,
    modules,
    paths: ["/proof", "/proof-again"],
  };
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return inventory;
}

async function copyKernelModule(
  sourcePath: string,
  cloudRoot: string,
  outputDir: string,
  copied: Set<string>,
): Promise<SourceRecord[]> {
  const normalized = NodePath.posix.normalize(sourcePath);
  if (copied.has(normalized)) return [];
  if (!normalized.startsWith("src/kernel/")) {
    throw new Error(`Unexpected ripgrep proof dependency outside the kernel: ${normalized}`);
  }
  copied.add(normalized);
  const sourceFile = NodePath.resolve(cloudRoot, normalized);
  const source = await NodeFSP.readFile(sourceFile, "utf8");
  const dependencies = [
    ...source.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+\.ts)["']/g),
  ].map((match) =>
    NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(normalized), match[1]!)),
  );
  const dependencySources = await Promise.all(
    dependencies.map((dependency) => copyKernelModule(dependency, cloudRoot, outputDir, copied)),
  );
  const javascript = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replace(
    /(["'])(\.{1,2}\/[^"']+)\.ts\1/g,
    "$1$2.js$1",
  );
  const outputPath = NodePath.join(outputDir, normalized.replace(/\.ts$/, ".js"));
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  await NodeFSP.writeFile(outputPath, javascript);
  return [
    { path: normalized, bytes: Buffer.byteLength(source), sha256: digest(source) },
    ...dependencySources.flat(),
  ];
}

function digest(bytes: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (destination === undefined) {
    throw new Error("Pass a destination directory for the ripgrep proof facet");
  }
  const inventory = await prepareKernelRipgrepFacet(
    NodePath.resolve(destination),
    process.argv[3] === undefined ? undefined : NodePath.resolve(process.argv[3]),
    process.argv[4] === undefined ? undefined : NodePath.resolve(process.argv[4]),
    process.argv[5],
  );
  console.log(JSON.stringify({ destination: NodePath.resolve(destination), inventory }, null, 2));
}

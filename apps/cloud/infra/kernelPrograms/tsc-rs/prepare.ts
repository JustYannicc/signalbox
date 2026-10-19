import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { KERNEL_TSC_ARTIFACT } from "../../../src/kernel/KernelTscProgram.ts";
import { TSC_PROBE_SOURCE } from "./proof-source.ts";
import { TSC_CHILD_SOURCE } from "./child-source.ts";

const ARTIFACT = Object.freeze({
  ...KERNEL_TSC_ARTIFACT,
  name: "tsc-rs",
  path: "ts_rust.wasm",
});
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
type SourceRecord = { readonly path: string; readonly bytes: number; readonly sha256: string };
type ModuleType = "js" | "wasm";
type Provenance = {
  readonly artifact: {
    readonly imports: readonly string[];
    readonly exports: readonly string[];
  };
};

/** Package facet ownership and the compiler child with a static WASM module. */
export async function prepareKernelTscFacet(
  destination: string,
  artifactPath?: string,
  sourceRoot?: string,
  sourceRevision?: string,
) {
  const sourcePath = NodePath.resolve(artifactPath ?? NodePath.join(scriptDir, "bin/ts_rust.wasm"));
  const provenance = JSON.parse(
    await NodeFSP.readFile(NodePath.join(scriptDir, "provenance.json"), "utf8"),
  ) as Provenance;
  const bytes = await NodeFSP.readFile(sourcePath);
  if (bytes.byteLength !== ARTIFACT.bytes || digest(bytes) !== ARTIFACT.sha256) {
    throw new Error("ts-rust artifact does not match its frozen source pin");
  }
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module).map(({ module, name }) => `${module}.${name}`);
  const exports = WebAssembly.Module.exports(module).map(({ name }) => name);
  if (JSON.stringify(imports) !== JSON.stringify(provenance.artifact.imports)) {
    throw new Error("ts-rust WASM import inventory changed");
  }
  if (JSON.stringify(exports) !== JSON.stringify(provenance.artifact.exports)) {
    throw new Error("ts-rust WASM export inventory changed");
  }

  const kernelRoot = NodePath.resolve(
    sourceRoot ?? NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const outputDir = NodePath.resolve(destination);
  const copied = new Set<string>();
  const referenced = [
    ...TSC_PROBE_SOURCE.matchAll(
      /(?:from\s*|import\s*\(\s*)["'](\.\.\/\.\.\/\.\.\/src\/(?:kernel|computer)\/[^"']+\.ts)["']/g,
    ),
  ].map((match) => match[1]!.replace(/^\.\.\/\.\.\/\.\.\//, ""));
  if (referenced.length === 0) throw new Error("tsc proof source has no packaged kernel imports");
  const sources = await Promise.all(
    referenced.map((path) => copyKernelModule(path, kernelRoot, outputDir, copied)),
  ).then((records) => records.flat());
  const childCopied = new Set<string>();
  for (const path of ["src/kernel/KernelTscReactor.ts", "src/computer/ChildWasi.ts"]) {
    sources.push(...(await copyKernelModule(path, kernelRoot, outputDir, childCopied)));
  }
  const childModules: Record<string, { js: string }> = { "main.js": { js: TSC_CHILD_SOURCE } };
  for (const path of childCopied) {
    const name = path.replace(/\.ts$/, ".js");
    childModules[name] = { js: await NodeFSP.readFile(NodePath.join(outputDir, name), "utf8") };
  }
  const childModuleSource = `export default ${JSON.stringify(childModules)};\n`;
  const proofBytes = await NodeFSP.readFile(NodePath.join(scriptDir, "proof-source.ts"));
  const childBytes = await NodeFSP.readFile(NodePath.join(scriptDir, "child-source.ts"));
  const builderBytes = await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url));
  sources.push(
    {
      path: "infra/kernelPrograms/tsc-rs/child-source.ts",
      bytes: childBytes.byteLength,
      sha256: digest(childBytes),
    },
    {
      path: "infra/kernelPrograms/tsc-rs/proof-source.ts",
      bytes: proofBytes.byteLength,
      sha256: digest(proofBytes),
    },
    {
      path: "infra/kernelPrograms/tsc-rs/prepare.ts",
      bytes: builderBytes.byteLength,
      sha256: digest(builderBytes),
    },
  );
  const uniqueSources = [...new Map(sources.map((source) => [source.path, source])).values()];
  uniqueSources.sort((a, b) => a.path.localeCompare(b.path));

  const main = TSC_PROBE_SOURCE.replace(
    /from (["'])\.\.\/\.\.\/\.\.\/src\/(kernel|computer)\//g,
    "from $1./src/$2/",
  ).replace(/(from )(["'])(\.\/src\/(?:kernel|computer)\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
  if (!TSC_CHILD_SOURCE.includes('from "./ts_rust.wasm"')) {
    throw new Error("tsc child must statically import ts_rust.wasm");
  }
  if (/WebAssembly\.(?:compile|compileStreaming)\s*\(|new\s+WebAssembly\.Module\s*\(/.test(main)) {
    throw new Error("tsc proof cannot compile WASM at runtime");
  }

  await NodeFSP.mkdir(outputDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main);
  await NodeFSP.writeFile(NodePath.join(outputDir, "child-modules.js"), childModuleSource);
  await NodeFSP.writeFile(NodePath.join(outputDir, ARTIFACT.path), bytes);

  const noticeFiles = [
    "LICENSE",
    "NOTICE.md",
    "licenses/Go-LICENSE.txt",
    "licenses/TypeScript-LICENSE.txt",
    "licenses/TypeScript-NOTICE.txt",
    "licenses/Unicode-LICENSE.txt",
    "licenses/vscode-languageserver-node-LICENSE.txt",
  ];
  const notices = await Promise.all(
    noticeFiles.map(async (path) => {
      const bytes = await NodeFSP.readFile(NodePath.join(scriptDir, path));
      return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
    }),
  );
  for (const relative of ["LICENSE", "NOTICE.md", "licenses"]) {
    await NodeFSP.cp(NodePath.join(scriptDir, relative), NodePath.join(outputDir, relative), {
      recursive: true,
    });
  }

  const modules: Record<string, { path: string; type: ModuleType }> = {
    "main.js": { path: "main.js", type: "js" },
    "child-modules.js": { path: "child-modules.js", type: "js" },
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
    notices,
    sourceRevision: sourceRevision ?? null,
    wasmImports: imports,
    wasmExports: exports,
    sources: uniqueSources,
    childModules: Object.entries(childModules).map(([name, value]) => ({
      name,
      bytes: Buffer.byteLength(value.js),
      sha256: digest(value.js),
    })),
    modules: [
      { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
      {
        name: "child-modules.js",
        type: "js",
        bytes: Buffer.byteLength(childModuleSource),
        sha256: digest(childModuleSource),
      },
      ...kernelModules,
    ],
  };
  const manifest = {
    id: "kernel-tsc-rs-proof-v1",
    sourceRevision: sourceRevision ?? null,
    mainModule: "main.js",
    entrypoint: "ProbeFacet",
    mode: "facet",
    allowOutbound: false,
    allowChildWorkers: true,
    modules,
    requests: [
      ...["/proof", "/proof-again"].map((path) => ({
        path,
        method: "POST",
        bodyFile: "ts_rust.wasm",
        contentType: "application/wasm",
      })),
      { path: "/large-policy", method: "GET" },
    ],
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
  if (!/^src\/(?:kernel|computer)\//.test(normalized)) {
    throw new Error(`Unexpected tsc proof dependency outside kernel/computer: ${normalized}`);
  }
  copied.add(normalized);
  const sourceFile = NodePath.resolve(cloudRoot, normalized);
  const source = await NodeFSP.readFile(sourceFile, "utf8");
  const stripped = NodeModule.stripTypeScriptTypes(source, { mode: "strip" });
  const dependencies = [
    ...stripped.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.\.?\/[^"']+\.ts)["']/g),
  ].map((match) =>
    NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(normalized), match[1]!)),
  );
  const dependencySources = await Promise.all(
    dependencies.map((dependency) => copyKernelModule(dependency, cloudRoot, outputDir, copied)),
  );
  const javascript = stripped.replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, "$1$2.js$1");
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
    throw new Error("Pass a destination directory for the tsc proof facet");
  }
  const inventory = await prepareKernelTscFacet(
    NodePath.resolve(destination),
    process.argv[3] === undefined ? undefined : NodePath.resolve(process.argv[3]),
    process.argv[4] === undefined ? undefined : NodePath.resolve(process.argv[4]),
    process.argv[5],
  );
  process.stdout.write(
    `${JSON.stringify({ destination: NodePath.resolve(destination), inventory }, null, 2)}\n`,
  );
}

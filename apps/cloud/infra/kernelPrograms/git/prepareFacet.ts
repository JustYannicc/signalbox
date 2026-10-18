// @effect-diagnostics nodeBuiltinImport:off - build-time packaging of a static WASM facet.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_GIT_ARTIFACT } from "../../../src/kernel/KernelGitProgram.ts";
import { gitArtifactPath } from "./prepare.ts";
import { KERNEL_GIT_FACET_SOURCE } from "./facet-source.ts";

const SOURCE_MARKER = "__KERNEL_GIT_FACET_SOURCE_INVENTORY__";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface SourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Package the Git proof with a static WASM import for local or deployed DO execution. */
export async function prepareKernelGitFacet(
  destination: string,
  revision: string,
  wasmPath = gitArtifactPath,
  sourceRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url)),
  busyboxPath = NodePath.join(scriptDir, "../coreutils/bin/busybox.wasm"),
) {
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("Pass the exact 40-character source commit");
  const bytes = await NodeFSP.readFile(wasmPath);
  if (
    bytes.byteLength !== KERNEL_GIT_ARTIFACT.bytes ||
    digest(bytes) !== KERNEL_GIT_ARTIFACT.sha256
  ) {
    throw new Error("Git WASM does not match its frozen source pin");
  }

  const busyboxBytes = await NodeFSP.readFile(busyboxPath);
  if (
    busyboxBytes.byteLength !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    digest(busyboxBytes) !== KERNEL_BUSYBOX_ARTIFACT.sha256
  ) {
    throw new Error("BusyBox filter artifact does not match its frozen source pin");
  }
  const catBase64 = busyboxBytes.toString("base64");
  const cloudRoot = NodePath.resolve(sourceRoot);
  const outputDir = NodePath.resolve(destination);
  const build = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      contents: KERNEL_GIT_FACET_SOURCE,
      resolveDir: scriptDir,
      sourcefile: "kernel-git-facet-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["cloudflare:workers", "node:*", "./git.wasm", "./busybox.wasm", "./cat-bytes.txt"],
  });
  const sources = await Promise.all(
    Object.keys(build.metafile.inputs)
      .filter((path) => !path.endsWith("kernel-git-facet-entry.ts"))
      .sort()
      .map(async (path) => sourceRecord(cloudRoot, path)),
  );
  sources.push(
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git/facet-source.ts"),
    await sourceRecord(cloudRoot, "infra/kernelPrograms/git/prepareFacet.ts"),
  );
  sources.sort((left, right) => left.path.localeCompare(right.path));

  const output = build.outputFiles[0]?.text;
  if (output === undefined || !output.includes(JSON.stringify(SOURCE_MARKER))) {
    throw new Error("Git facet bundle lost its source inventory marker");
  }
  const main = output.replace(
    JSON.stringify(SOURCE_MARKER),
    JSON.stringify({ revision, files: sources }),
  );
  if (
    !main.includes('import git from "./git.wasm"') ||
    /WebAssembly\.(?:Module|compile)\s*\(|\beval\s*\(/.test(main)
  ) {
    throw new Error(
      "Git facet must retain a static WASM import without runtime compilation or eval",
    );
  }

  await NodeFSP.mkdir(outputDir, { recursive: true });
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main),
    NodeFSP.writeFile(NodePath.join(outputDir, "git.wasm"), bytes),
    NodeFSP.writeFile(NodePath.join(outputDir, "busybox.wasm"), busyboxBytes),
    NodeFSP.writeFile(NodePath.join(outputDir, "cat-bytes.txt"), catBase64),
  ]);
  const modules = [
    { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
    { name: "git.wasm", type: "wasm", bytes: bytes.byteLength, sha256: digest(bytes) },
    {
      name: "busybox.wasm",
      type: "wasm",
      bytes: busyboxBytes.byteLength,
      sha256: digest(busyboxBytes),
    },
    {
      name: "cat-bytes.txt",
      type: "text",
      bytes: Buffer.byteLength(catBase64),
      sha256: digest(catBase64),
    },
  ];
  const inventory = { artifact: KERNEL_GIT_ARTIFACT, sourceRevision: revision, sources, modules };
  const manifest = {
    id: "kernel-git-proof-v1",
    sourceRevision: revision,
    mainModule: "main.js",
    entrypoint: "KernelGitFacet",
    mode: "facet",
    allowOutbound: false,
    modules: {
      "main.js": { path: "main.js", type: "js" },
      "git.wasm": { path: "git.wasm", type: "wasm" },
      "busybox.wasm": { path: "busybox.wasm", type: "wasm" },
      "cat-bytes.txt": { path: "cat-bytes.txt", type: "text" },
    },
    paths: ["/proof", "/proof-again"],
  };
  await Promise.all([
    NodeFSP.writeFile(
      NodePath.join(outputDir, "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
    ),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
  return inventory;
}

async function sourceRecord(root: string, path: string): Promise<SourceRecord> {
  const bytes = await NodeFSP.readFile(NodePath.resolve(root, path));
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const revision = process.argv[3];
  const wasmPath = process.argv[4];
  const sourceRoot = process.argv[5];
  if (!destination || !revision) {
    throw new Error(
      "Pass a destination and exact source commit (plus optional WASM path and cloud source root)",
    );
  }
  const inventory = await prepareKernelGitFacet(
    NodePath.resolve(destination),
    revision,
    wasmPath === undefined ? undefined : NodePath.resolve(wasmPath),
    sourceRoot === undefined ? undefined : NodePath.resolve(sourceRoot),
  );
  process.stdout.write(
    `${JSON.stringify({ destination: NodePath.resolve(destination), inventory }, null, 2)}\n`,
  );
}

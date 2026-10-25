// @effect-diagnostics nodeBuiltinImport:off - static module fixture preparation only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../../src/kernel/KernelBusyboxProgram.ts";

const BASH = Object.freeze({
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "build/bash.async.wasm",
  version: "5.2.37+nimbus.e9f019ab.fd-flags.2",
  sha256: "c3e8dc79b9660a21ed1873f8c900a0c1f195d274c183706cf5f68ff9e5fb9e00",
  bytes: 3_890_330,
});
const BUSYBOX = KERNEL_BUSYBOX_ARTIFACT;
const SOURCE_MARKER = "__KERNEL_COREUTILS_PROOF_SOURCE_INVENTORY__";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface SourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Build one static Cloudflare facet with pinned GNU Bash and BusyBox modules. */
export async function prepareKernelCoreutilsFacet(
  destination: string,
  bashPath = NodePath.join(scriptDir, "../bash/build/bash.async.wasm"),
  busyboxPath = NodePath.join(scriptDir, BUSYBOX.path),
) {
  const [bashBytes, busyboxBytes] = await Promise.all([
    NodeFSP.readFile(bashPath),
    NodeFSP.readFile(busyboxPath),
  ]);
  assertArtifact("GNU Bash", bashBytes, BASH);
  assertArtifact("Nimbus BusyBox", busyboxBytes, BUSYBOX);
  const cloudRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const build = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      contents: await NodeFSP.readFile(NodePath.join(scriptDir, "facet-source.ts"), "utf8"),
      resolveDir: scriptDir,
      sourcefile: "kernel-coreutils-proof-facet.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["cloudflare:workers", "node:*", "./bash.wasm", "./busybox.wasm", "./cat-bytes.txt"],
  });
  const sources = await Promise.all(
    Object.keys(build.metafile.inputs)
      .filter((path) => !path.endsWith("kernel-coreutils-proof-facet.ts"))
      .sort()
      .map(async (path) => sourceRecord(cloudRoot, path)),
  );
  sources.push(await sourceRecord(cloudRoot, "infra/kernelPrograms/coreutils/facet-source.ts"));
  sources.sort((left, right) => left.path.localeCompare(right.path));
  const builderSource = await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url));
  sources.push({
    path: "infra/kernelPrograms/coreutils/prepareFacet.ts",
    bytes: builderSource.byteLength,
    sha256: digest(builderSource),
  });

  const output = build.outputFiles[0]?.text;
  if (output === undefined || !output.includes(JSON.stringify(SOURCE_MARKER))) {
    throw new Error("Coreutils facet bundle lost its source inventory marker");
  }
  if (/WebAssembly\.Module\s*\(|\beval\s*\(/.test(output)) {
    throw new Error(
      "Coreutils facet must use static WASM modules without runtime compilation or eval",
    );
  }
  const main = output.replace(JSON.stringify(SOURCE_MARKER), JSON.stringify(sources));
  const base64Bytes = Buffer.from(busyboxBytes).toString("base64");
  const modules = [
    { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
    { name: "bash.wasm", type: "wasm", bytes: bashBytes.byteLength, sha256: digest(bashBytes) },
    {
      name: "busybox.wasm",
      type: "wasm",
      bytes: busyboxBytes.byteLength,
      sha256: digest(busyboxBytes),
    },
    {
      name: "cat-bytes.txt",
      type: "text",
      bytes: Buffer.byteLength(base64Bytes),
      sha256: digest(base64Bytes),
    },
  ];
  const outputDir = NodePath.resolve(destination);
  await NodeFSP.mkdir(outputDir, { recursive: true });
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main),
    NodeFSP.writeFile(NodePath.join(outputDir, "bash.wasm"), bashBytes),
    NodeFSP.writeFile(NodePath.join(outputDir, "busybox.wasm"), busyboxBytes),
    NodeFSP.writeFile(NodePath.join(outputDir, "cat-bytes.txt"), base64Bytes),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "inventory.json"),
      `${JSON.stringify({ artifacts: { bash: BASH, busybox: BUSYBOX }, sources, modules }, null, 2)}\n`,
    ),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "manifest.json"),
      `${JSON.stringify(
        {
          id: "kernel-bash-busybox-cat-v1",
          mainModule: "main.js",
          entrypoint: "KernelCoreutilsFacet",
          mode: "facet",
          allowOutbound: false,
          modules: {
            "main.js": { path: "main.js", type: "js" },
            "bash.wasm": { path: "bash.wasm", type: "wasm" },
            "busybox.wasm": { path: "busybox.wasm", type: "wasm" },
            "cat-bytes.txt": { path: "cat-bytes.txt", type: "text" },
          },
          paths: ["/proof", "/proof-again"],
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  return { artifacts: { bash: BASH, busybox: BUSYBOX }, sources, modules };
}

async function sourceRecord(root: string, path: string): Promise<SourceRecord> {
  const bytes = await NodeFSP.readFile(NodePath.resolve(root, path));
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function assertArtifact(
  name: string,
  bytes: Uint8Array,
  expected: { readonly bytes: number; readonly sha256: string },
) {
  if (bytes.byteLength !== expected.bytes || digest(bytes) !== expected.sha256) {
    throw new Error(`${name} does not match its frozen source pin`);
  }
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const bashPath = process.argv[3];
  const busyboxPath = process.argv[4];
  if (!destination) throw new Error("Pass a fixture output directory");
  const inventory = await prepareKernelCoreutilsFacet(
    NodePath.resolve(destination),
    bashPath === undefined ? undefined : NodePath.resolve(bashPath),
    busyboxPath === undefined ? undefined : NodePath.resolve(busyboxPath),
  );
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

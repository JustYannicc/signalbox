import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { PRODUCT_COMPUTER_BUSYBOX_ARTIFACT } from "../../../src/kernel/KernelBusyboxProgram.ts";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outputDirectory = NodePath.resolve(process.argv[2] ?? NodePath.join(scriptDirectory, "bin"));
const candidatePath = process.argv[3] ?? NodePath.join(outputDirectory, "product-busybox.wasm");
const buildManifestPath =
  process.argv[4] ?? NodePath.join(outputDirectory, "busybox.manifest.json");
const [wasmBytes, buildManifestBytes] = await Promise.all([
  NodeFSP.readFile(candidatePath),
  NodeFSP.readFile(buildManifestPath),
]);
const buildManifest = JSON.parse(buildManifestBytes.toString("utf8"));
const source = buildManifest.source;
const artifact = buildManifest.artifact;
if (
  buildManifest.schemaVersion !== 1 ||
  source?.profile !== "product-computer" ||
  source?.repository !== PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.repository ||
  source?.commit !== PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.revision ||
  source?.buildRecipe !== PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sourceBuildRecipe ||
  source?.buildRecipeSha256 !== PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sourceBuildRecipeSha256 ||
  artifact?.file !== "product-busybox.wasm"
) {
  throw new Error("ProductComputer BusyBox build manifest does not match the pinned recipe");
}
assertPin(
  wasmBytes,
  PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.bytes,
  PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sha256,
);
if (
  artifact.bytes !== wasmBytes.byteLength ||
  artifact.sha256 !== PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sha256
) {
  throw new Error("ProductComputer BusyBox build manifest has an unexpected artifact pin");
}

const module = await WebAssembly.compile(wasmBytes);
const imports = WebAssembly.Module.imports(module)
  .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
  .sort();
const exports = WebAssembly.Module.exports(module)
  .map(({ name, kind }) => `${name}:${kind}`)
  .sort();
if (
  JSON.stringify(imports) !== JSON.stringify([...artifact.imports].sort()) ||
  JSON.stringify(exports) !== JSON.stringify([...artifact.exports].sort())
) {
  throw new Error("ProductComputer BusyBox ABI differs from the build manifest");
}

await NodeFSP.mkdir(outputDirectory, { recursive: true });
await NodeFSP.copyFile(candidatePath, NodePath.join(outputDirectory, "product-busybox.wasm"));
const provenance = {
  ...PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
  artifact: { bytes: wasmBytes.byteLength, sha256: PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sha256 },
  source: {
    repository: source.repository,
    revision: source.commit,
    nimbusArchiveSha256: source.nimbusArchiveSha256,
    busyboxArchiveSha256: source.busyboxArchiveSha256,
    wasiSdkArchiveSha256: buildManifest.toolchain.wasiSdkArchiveSha256,
    buildRecipe: source.buildRecipe,
    buildRecipeSha256: source.buildRecipeSha256,
    patches: [
      source.bufferPatch,
      source.buildRecipePatch,
      source.appletConfigPatch,
      source.accountAbiPatch,
    ],
  },
  imports,
  exports,
  buildManifestSha256: NodeCrypto.createHash("sha256").update(buildManifestBytes).digest("hex"),
};
await NodeFSP.writeFile(
  NodePath.join(outputDirectory, "product-busybox.provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);
console.log(JSON.stringify({ outputDirectory, ...PRODUCT_COMPUTER_BUSYBOX_ARTIFACT }));

function assertPin(bytes, expectedBytes, expectedSha256) {
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expectedBytes || sha256 !== expectedSha256) {
    throw new Error(`ProductComputer BusyBox pin mismatch: ${bytes.byteLength} bytes ${sha256}`);
  }
}

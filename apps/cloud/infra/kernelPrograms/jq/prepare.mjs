import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { KERNEL_JQ_ARTIFACT } from "../../../src/kernel/KernelJqProgram.ts";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outputDirectory = NodePath.resolve(process.argv[2] ?? NodePath.join(scriptDirectory, "bin"));
const packagePath = process.argv[3];
const manifestUrl = new URL(
  KERNEL_JQ_ARTIFACT.registryManifestPath,
  KERNEL_JQ_ARTIFACT.registryRoot,
);
const packageUrl = new URL(
  `${KERNEL_JQ_ARTIFACT.version}/software/${KERNEL_JQ_ARTIFACT.packagePath}`,
  KERNEL_JQ_ARTIFACT.registryRoot,
);

await verifyRegistryManifest();
const packageBytes =
  packagePath === undefined ? await download(packageUrl) : await NodeFSP.readFile(packagePath);
assertPin(
  packageBytes,
  KERNEL_JQ_ARTIFACT.packageBytes,
  KERNEL_JQ_ARTIFACT.packageSha256,
  "AgentOS jq package",
);

const tarBytes = packageMountTar(packageBytes);
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-jq-"));
try {
  const tarPath = NodePath.join(scratch, "jq.tar");
  await NodeFSP.writeFile(tarPath, tarBytes);
  const wasmBytes = NodeChildProcess.execFileSync(
    "tar",
    ["-xOf", tarPath, `./${KERNEL_JQ_ARTIFACT.packageEntry}`],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  assertPin(wasmBytes, KERNEL_JQ_ARTIFACT.bytes, KERNEL_JQ_ARTIFACT.sha256, "AgentOS jq WASM");
  const module = await WebAssembly.compile(wasmBytes);
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name, kind }) => ({ module, name, kind }))
    .sort(compareAbi);
  const expectedImports = [...KERNEL_JQ_ARTIFACT.imports].sort(compareAbi);
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error("AgentOS jq import inventory does not match its pin");
  }
  const exports = WebAssembly.Module.exports(module)
    .map(({ name, kind }) => ({ name, kind }))
    .sort(compareAbi);
  const expectedExports = [...KERNEL_JQ_ARTIFACT.exports].sort(compareAbi);
  if (JSON.stringify(exports) !== JSON.stringify(expectedExports)) {
    throw new Error("AgentOS jq export inventory does not match its pin");
  }

  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, KERNEL_JQ_ARTIFACT.preparedFile),
    wasmBytes,
  );
  const provenance = {
    package: "@agentos-software/jq",
    version: KERNEL_JQ_ARTIFACT.version,
    registryManifestUrl: manifestUrl.toString(),
    packageUrl: packageUrl.toString(),
    packageArtifact: {
      path: KERNEL_JQ_ARTIFACT.packagePath,
      bytes: KERNEL_JQ_ARTIFACT.packageBytes,
      sha256: KERNEL_JQ_ARTIFACT.packageSha256,
    },
    packageEntry: KERNEL_JQ_ARTIFACT.packageEntry,
    artifact: {
      file: KERNEL_JQ_ARTIFACT.preparedFile,
      bytes: wasmBytes.byteLength,
      sha256: KERNEL_JQ_ARTIFACT.sha256,
    },
    imports,
    exports,
  };
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "jq.provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  console.log(JSON.stringify({ outputDirectory, ...provenance }));
} finally {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}

async function verifyRegistryManifest() {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Could not read AgentOS software manifest: ${response.status}`);
  const manifest = await response.json();
  const artifact = manifest.artifacts?.find(
    (entry) => entry.name === "jq" && entry.path === KERNEL_JQ_ARTIFACT.packagePath,
  );
  if (
    manifest.schemaVersion !== 1 ||
    artifact?.digest !== `sha256:${KERNEL_JQ_ARTIFACT.packageSha256}` ||
    artifact?.size !== KERNEL_JQ_ARTIFACT.packageBytes
  ) {
    throw new Error("AgentOS jq release manifest does not match the pinned package");
  }
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not download pinned AgentOS jq package: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function packageMountTar(bytes) {
  const container = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    container.byteLength < 16 ||
    !container.subarray(0, 4).equals(Buffer.from([0x89, 0x41, 0x4f, 0x53]))
  ) {
    throw new Error("AgentOS jq package has an invalid .aospkg header");
  }
  const formatVersion = container.readUInt16LE(4);
  const manifestLength = container.readUInt32LE(8);
  const indexLength = container.readUInt32LE(12);
  const payloadOffset = 16 + manifestLength + indexLength;
  if (formatVersion !== 2 || payloadOffset > container.byteLength) {
    throw new Error(`Unexpected AgentOS .aospkg header (format ${formatVersion})`);
  }
  return container.subarray(payloadOffset);
}

function assertPin(bytes, expectedBytes, expectedSha256, label) {
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expectedBytes || sha256 !== expectedSha256) {
    throw new Error(`${label} pin mismatch: ${bytes.byteLength} bytes ${sha256}`);
  }
}

function compareAbi(left, right) {
  const leftKey = `${left.module ?? ""}\0${left.name}\0${left.kind}`;
  const rightKey = `${right.module ?? ""}\0${right.name}\0${right.kind}`;
  return leftKey.localeCompare(rightKey);
}

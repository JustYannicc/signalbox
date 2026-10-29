import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  applyGitTemplateSubstitutions,
  mountAospkgTar,
  readTarMember,
  safeRelative,
  sha256,
  verifyPinnedBytes,
} from "./productProgramArchive.ts";
import { fetchPinned, readResponseBytes, requireHttps } from "./productProgramAssets.ts";
import {
  runBuild,
  safeBuildEnvironment,
  writeJsonOnce,
  writeOnce,
} from "./productProgramRuntime.ts";
import type { Pin, ProductProgramPinSnapshot } from "./productProgramTypes.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export async function fetchJq(
  fetchAsset: typeof fetch,
  output: string,
  work: string,
  pins: ProductProgramPinSnapshot,
) {
  const releaseManifestResponse = await fetchAsset(pins.jqPackage.registryManifestUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!releaseManifestResponse.ok)
    throw new Error(`PRODUCT_PROGRAM_JQ_REGISTRY_FAILED:${releaseManifestResponse.status}`);
  requireHttps(
    releaseManifestResponse.url || pins.jqPackage.registryManifestUrl,
    "jq:registry-manifest",
  );
  const manifestBytes = await readResponseBytes(
    releaseManifestResponse,
    1_048_576,
    "jq:registry-manifest",
  );
  const registryManifest = parseRegistryManifest(manifestBytes, pins.jqPackage);
  const packageBytes = await fetchPinned(
    fetchAsset,
    {
      url: pins.jqPackage.packageUrl,
      bytes: pins.jqPackage.packageBytes,
      sha256: pins.jqPackage.packageSha256,
    },
    "jq:package",
  );
  const mountTar = mountAospkgTar(packageBytes);
  const archivePath = NodePath.join(work, "jq-package.tar");
  await NodeFSP.writeFile(archivePath, mountTar, { flag: "wx", mode: 0o600 });
  const jqBytes = await readTarMember(archivePath, `./${pins.jqPackage.packageEntry}`);
  verifyPinnedBytes(jqBytes, pins.files.jq!, "jq.wasm");
  const candidatePath = NodePath.join(work, "jq.wasm");
  await writeOnce(candidatePath, jqBytes);
  const { stdout } = await execFile(
    process.execPath,
    [
      NodePath.resolve(
        import.meta.dirname,
        "../../apps/cloud/infra/harnessReleases/productProgramInputs.ts",
      ),
      "--inspect-wasm",
      candidatePath,
    ],
    { encoding: "utf8", env: safeBuildEnvironment(), timeout: 30000, maxBuffer: 1048576 },
  );
  const inspected: unknown = JSON.parse(stdout);
  const imports = [...pins.jqPackage.imports].sort(compareAbi);
  const exports = [...pins.jqPackage.exports].sort(compareAbi);
  if (
    !isRecord(inspected) ||
    !Array.isArray(inspected.imports) ||
    !Array.isArray(inspected.exports) ||
    JSON.stringify(inspected.imports.sort(compareAbi)) !== JSON.stringify(imports) ||
    JSON.stringify(inspected.exports.sort(compareAbi)) !== JSON.stringify(exports)
  )
    throw new Error("PRODUCT_PROGRAM_JQ_ABI_MISMATCH");
  await writeOnce(NodePath.join(output, pins.files.jq!.file), jqBytes);
  const provenance = {
    package: "@agentos-software/jq",
    version: pins.files.jq!.revision,
    registryManifestUrl: pins.jqPackage.registryManifestUrl,
    packageUrl: pins.jqPackage.packageUrl,
    packageArtifact: {
      path: pins.jqPackage.packagePath,
      bytes: pins.jqPackage.packageBytes,
      sha256: pins.jqPackage.packageSha256,
    },
    packageEntry: pins.jqPackage.packageEntry,
    artifact: {
      file: pins.files.jq!.file,
      bytes: jqBytes.byteLength,
      sha256: pins.files.jq!.sha256,
    },
    imports,
    exports,
  };
  await writeJsonOnce(NodePath.join(output, "jq.provenance.json"), provenance);
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  return {
    packageBytes: packageBytes.byteLength,
    packageSha256: pins.jqPackage.packageSha256,
    registryManifestSha256: sha256(manifestBytes),
    registryManifestArtifacts: registryManifest,
    artifact: {
      file: pins.files.jq!.file,
      bytes: jqBytes.byteLength,
      sha256: pins.files.jq!.sha256,
    },
    provenanceBytes: provenanceBytes.byteLength,
    provenanceSha256: sha256(provenanceBytes),
  };
}

function parseRegistryManifest(bytes: Uint8Array, pins: ProductProgramPinSnapshot["jqPackage"]) {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts))
    throw new Error("PRODUCT_PROGRAM_JQ_REGISTRY_MANIFEST_INVALID");
  const artifact = value.artifacts.find(
    (entry) => isRecord(entry) && entry.name === "jq" && entry.path === pins.packagePath,
  );
  if (
    !isRecord(artifact) ||
    artifact.size !== pins.packageBytes ||
    artifact.digest !== `sha256:${pins.packageSha256}`
  ) {
    throw new Error("PRODUCT_PROGRAM_JQ_REGISTRY_PIN_DRIFT");
  }
  return {
    name: "jq",
    path: pins.packagePath,
    bytes: pins.packageBytes,
    sha256: pins.packageSha256,
  };
}

export async function buildGit(
  repositoryRoot: string,
  output: string,
  work: string,
  pins: ProductProgramPinSnapshot,
) {
  const workRoot = NodePath.join(work, "git");
  const script = NodePath.join(repositoryRoot, "apps/cloud/infra/kernelPrograms/git/build.sh");
  await runBuild("bash", [script, workRoot], repositoryRoot, NodePath.join(work, "git-build.log"));
  const buildDirectory = NodePath.join(workRoot, "output");
  const artifactPath = NodePath.join(buildDirectory, "git.cwd.wasm");
  const artifactBytes = new Uint8Array(await NodeFSP.readFile(artifactPath));
  verifyPinnedBytes(artifactBytes, pins.files.git!, "git.wasm");
  const manifestBytes = new Uint8Array(
    await NodeFSP.readFile(NodePath.join(buildDirectory, "manifest.json")),
  );
  const manifest = parseGitBuildManifest(manifestBytes, pins.files.git!, pins.gitBuild);
  await writeOnce(NodePath.join(output, pins.files.git!.file), artifactBytes);
  await writeOnce(NodePath.join(output, "git.build-manifest.json"), manifestBytes);
  return {
    sourceArchive: NodePath.join(workRoot, "downloads", "git-2.53.0.tar.xz"),
    receipt: {
      program: "git",
      file: pins.files.git!.file,
      bytes: artifactBytes.byteLength,
      sha256: pins.files.git!.sha256,
      buildManifestSha256: sha256(manifestBytes),
      inputs: manifest.inputs,
    },
  };
}

function parseGitBuildManifest(
  bytes: Uint8Array,
  pin: Pin,
  expected: ProductProgramPinSnapshot["gitBuild"],
) {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isRecord(value) ||
    !isRecord(value.output) ||
    value.output.bytes !== pin.bytes ||
    value.output.sha256 !== pin.sha256 ||
    !isRecord(value.inputs) ||
    Object.values(value.inputs).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  ) {
    throw new Error("PRODUCT_PROGRAM_GIT_BUILD_MANIFEST_INVALID");
  }
  if (
    value.recipeSha256 !== expected.recipeSha256 ||
    value.image !== expected.image ||
    JSON.stringify(value.inputs) !== JSON.stringify(expected.inputs)
  ) {
    throw new Error("PRODUCT_PROGRAM_GIT_BUILD_PROVENANCE_MISMATCH");
  }
  return value as { readonly inputs: Readonly<Record<string, string>> };
}

export async function extractGitTemplates(
  archivePath: string,
  output: string,
  pins: ProductProgramPinSnapshot,
) {
  const sourceBytes = new Uint8Array(await NodeFSP.readFile(archivePath));
  verifyPinnedBytes(
    sourceBytes,
    {
      bytes: pins.gitTemplates.source.archiveBytes,
      sha256: pins.gitTemplates.source.archiveSha256,
    },
    "git-2.53.0.tar.xz",
  );
  const extracted = [];
  for (const file of pins.gitTemplates.files) {
    const source = await readTarMember(archivePath, file.sourceMember);
    const bytes = applyGitTemplateSubstitutions(file.relativeInstallPath, source);
    verifyPinnedBytes(bytes, file, file.path);
    const relativePath = file.assetPath.replace(/^git-templates\//, "");
    if (!safeRelative(relativePath))
      throw new Error("PRODUCT_PROGRAM_TEMPLATE_OUTPUT_PATH_INVALID");
    const target = NodePath.join(output, "git-templates", ...relativePath.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o755 });
    await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: file.mode });
    await NodeFSP.chmod(target, file.mode);
    extracted.push({
      path: file.assetPath,
      bytes: bytes.byteLength,
      sha256: file.sha256,
      mode: file.mode,
    });
  }
  for (const directory of pins.gitTemplates.directories) {
    if (!safeRelative(directory.assetPath.replace(/^git-templates\//, "")))
      throw new Error("PRODUCT_PROGRAM_TEMPLATE_DIRECTORY_INVALID");
    await NodeFSP.mkdir(NodePath.join(output, ...directory.assetPath.split("/")), {
      recursive: true,
      mode: Number.parseInt(directory.mode, 8),
    });
    await NodeFSP.chmod(
      NodePath.join(output, ...directory.assetPath.split("/")),
      Number.parseInt(directory.mode, 8),
    );
  }
  await writeJsonOnce(NodePath.join(output, "git-templates.provenance.json"), {
    source: pins.gitTemplates.source,
    files: extracted,
    directories: pins.gitTemplates.directories,
  });
  const provenanceBytes = new Uint8Array(
    await NodeFSP.readFile(NodePath.join(output, "git-templates.provenance.json")),
  );
  await NodeFSP.rm(archivePath, { force: true });
  return {
    source: pins.gitTemplates.source,
    fileCount: extracted.length,
    files: extracted,
    provenanceBytes: provenanceBytes.byteLength,
    provenanceSha256: sha256(provenanceBytes),
  };
}

export async function buildProductBusybox(
  repositoryRoot: string,
  output: string,
  work: string,
  pins: ProductProgramPinSnapshot,
) {
  const buildRoot = NodePath.join(work, "product-busybox");
  const artifact = NodePath.join(buildRoot, "product-busybox.wasm");
  const buildManifest = NodePath.join(buildRoot, "busybox.manifest.json");
  const build = NodePath.join(
    repositoryRoot,
    "apps/cloud/infra/kernelPrograms/coreutils/build-busybox-buffered.sh",
  );
  await runBuild(
    "bash",
    [build, buildRoot, artifact, "product-computer"],
    repositoryRoot,
    NodePath.join(work, "product-busybox-build.log"),
  );
  const prepare = NodePath.join(
    repositoryRoot,
    "apps/cloud/infra/kernelPrograms/coreutils/prepare-product-busybox.mjs",
  );
  await runBuild(
    process.execPath,
    ["--experimental-strip-types", prepare, output, artifact, buildManifest],
    repositoryRoot,
    NodePath.join(work, "product-busybox-prepare.log"),
  );
  await writeOnce(
    NodePath.join(output, "product-busybox.build-manifest.json"),
    new Uint8Array(await NodeFSP.readFile(buildManifest)),
  );
  const outputPath = NodePath.join(output, pins.files.productBusybox!.file);
  await NodeFSP.chmod(outputPath, 0o444);
  const bytes = new Uint8Array(await NodeFSP.readFile(outputPath));
  verifyPinnedBytes(bytes, pins.files.productBusybox!, "product-busybox.wasm");
  const provenancePath = NodePath.join(output, "product-busybox.provenance.json");
  const provenance = JSON.parse(await NodeFSP.readFile(provenancePath, "utf8"));
  if (
    provenance.artifact?.bytes !== pins.files.productBusybox!.bytes ||
    provenance.artifact?.sha256 !== pins.files.productBusybox!.sha256 ||
    provenance.revision !== pins.files.productBusybox!.revision
  )
    throw new Error("PRODUCT_PROGRAM_BUSYBOX_PROVENANCE_MISMATCH");
  const provenanceBytes = new Uint8Array(await NodeFSP.readFile(provenancePath));
  return {
    program: "product-busybox",
    file: "product-busybox.wasm",
    bytes: bytes.byteLength,
    sha256: pins.files.productBusybox!.sha256,
    provenanceBytes: provenanceBytes.byteLength,
    provenanceSha256: sha256(provenanceBytes),
    buildManifestSha256: sha256(new Uint8Array(await NodeFSP.readFile(buildManifest))),
  };
}

function compareAbi(
  left: { readonly module?: string; readonly name: string; readonly kind: string },
  right: { readonly module?: string; readonly name: string; readonly kind: string },
): number {
  return `${left.module ?? ""}\0${left.name}\0${left.kind}`.localeCompare(
    `${right.module ?? ""}\0${right.name}\0${right.kind}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

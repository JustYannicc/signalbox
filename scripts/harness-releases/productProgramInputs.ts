import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { safeRelative } from "./productProgramArchive.ts";
import {
  RELEASE_MANIFESTS,
  PUBLISHED_ROOT,
  downloadPublishedPrograms,
  extractCoreutils,
  fetchPinned,
  parseProgramManifest,
  requireHttps,
} from "./productProgramAssets.ts";
import {
  buildGit,
  buildProductBusybox,
  extractGitTemplates,
  fetchJq,
} from "./productProgramBuilds.ts";
import {
  preserveProgramInputFailure,
  safeBuildEnvironment,
  writeJsonOnce,
} from "./productProgramRuntime.ts";
import type { Pin, ProductProgramPinSnapshot } from "./productProgramTypes.ts";

import { assertPreparedShape, type PreparedProductProgramShape } from "./productProgramShape.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repository = NodePath.resolve(import.meta.dirname, "../..");
export interface ProductProgramInputsOptions {
  readonly fetch?: typeof fetch;
  readonly repository?: string;
}

/** Fetches current public program assets and builds the two outputs absent from releases. */
export async function fetchProductProgramInputs(
  outputDirectory: string,
  options: ProductProgramInputsOptions = {},
) {
  const fetchAsset = options.fetch ?? fetch;
  const repositoryRoot = await NodeFSP.realpath(options.repository ?? repository);
  const output = NodePath.resolve(outputDirectory);
  if (inside(repositoryRoot, output))
    throw new Error("PRODUCT_PROGRAM_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT");
  const outputParent = await NodeFSP.realpath(NodePath.dirname(output));
  const root = NodePath.join(outputParent, NodePath.basename(output));
  if (inside(repositoryRoot, root))
    throw new Error("PRODUCT_PROGRAM_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT");
  await NodeFSP.mkdir(root, { recursive: false, mode: 0o700 });

  try {
    const pins = await readPinSnapshot(repositoryRoot);
    validatePinSnapshot(pins);
    await writeJsonOnce(NodePath.join(root, "program-pins.json"), pins);
    const programDirectory = root;
    const manifestDirectory = NodePath.join(root, "release-manifests");
    const workDirectory = NodePath.join(root, ".work");
    await NodeFSP.mkdir(manifestDirectory, { mode: 0o700 });
    await NodeFSP.mkdir(workDirectory, { mode: 0o700 });
    const manifests = await Promise.all(
      RELEASE_MANIFESTS.map(async (pin, index) => {
        const url = `${PUBLISHED_ROOT}/${pin.tag}/program-inputs.json`;
        const bytes = await fetchPinned(fetchAsset, { url, ...pin }, `manifest:${pin.tag}`);
        await NodeFSP.writeFile(NodePath.join(manifestDirectory, `${pin.tag}.json`), bytes, {
          flag: "wx",
          mode: 0o444,
        });
        return { index, pin, url, bytes, value: parseProgramManifest(bytes, pin.tag) };
      }),
    );

    const released = await downloadPublishedPrograms(
      fetchAsset,
      programDirectory,
      manifests.map((manifest) => manifest.value),
      pins,
    );
    await extractCoreutils(released.coreutilsArchive, programDirectory, pins);
    const jqReceipt = await fetchJq(fetchAsset, programDirectory, workDirectory, pins);
    const gitReceipt = await buildGit(repositoryRoot, programDirectory, workDirectory, pins);
    const gitTemplatesReceipt = await extractGitTemplates(
      gitReceipt.sourceArchive,
      programDirectory,
      pins,
    );
    const productBusyboxReceipt = await buildProductBusybox(
      repositoryRoot,
      programDirectory,
      workDirectory,
      pins,
    );
    const prepared = await verifyWithPublicPreparer(repositoryRoot, programDirectory);
    assertPreparedShape(prepared, pins);

    const receipt = {
      schemaVersion: 1,
      status: "inputs-verified",
      releaseManifests: manifests.map(({ index, pin, url }) => ({
        tag: RELEASE_MANIFESTS[index]!.tag,
        url,
        bytes: pin.bytes,
        sha256: pin.sha256,
      })),
      releasedAssets: released.receipts,
      coreutils: Object.entries(pins.coreutils.commands).map(([command, pin]) => ({
        command,
        file: pin.file,
        bytes: pin.bytes,
        sha256: pin.sha256,
      })),
      builtPrograms: [gitReceipt.receipt, productBusyboxReceipt],
      gitTemplates: gitTemplatesReceipt,
      jq: jqReceipt,
      prepared,
    };
    await NodeFSP.writeFile(
      NodePath.join(root, "verified-inputs.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    await NodeFSP.rm(workDirectory, { recursive: true });
    return { directory: root, receipt };
  } catch (error) {
    await preserveProgramInputFailure(root, error);
    throw error;
  }
}

async function readPinSnapshot(repositoryRoot: string): Promise<ProductProgramPinSnapshot> {
  const entry = NodePath.join(
    repositoryRoot,
    "apps/cloud/infra/harnessReleases/productProgramInputs.ts",
  );
  const { stdout } = await execFile(
    process.execPath,
    ["--experimental-strip-types", entry, "--describe"],
    {
      cwd: repositoryRoot,
      env: safeBuildEnvironment(),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("PRODUCT_PROGRAM_PIN_SNAPSHOT_INVALID", { cause });
  }
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error("PRODUCT_PROGRAM_PIN_SNAPSHOT_INVALID");
  return value as unknown as ProductProgramPinSnapshot;
}

function validatePinSnapshot(pins: ProductProgramPinSnapshot): void {
  if (
    !Array.isArray(pins.commandExecutablePaths) ||
    pins.commandExecutablePaths.length === 0 ||
    pins.commandExecutablePaths.some(
      (path) => typeof path !== "string" || !/^\/(?:usr\/)?bin\/[^/]+$/.test(path),
    ) ||
    new Set(pins.commandExecutablePaths).size !== pins.commandExecutablePaths.length
  )
    throw new Error("PRODUCT_PROGRAM_COMMAND_PATHS_INVALID");
  const files = ["bash", "busybox", "ripgrep", "git", "sed", "jq", "ugrep", "productBusybox"];
  if (!isRecord(pins.files) || files.some((name) => !validPin(pins.files[name])))
    throw new Error("PRODUCT_PROGRAM_PIN_SET_INVALID");
  if (
    !isRecord(pins.coreutils) ||
    !isRecord(pins.coreutils.commands) ||
    Object.keys(pins.coreutils.commands).length !== 12 ||
    Object.values(pins.coreutils.commands).some((pin) => !validPin(pin))
  ) {
    throw new Error("PRODUCT_PROGRAM_COREUTILS_PIN_SET_INVALID");
  }
  if (!validPin(pins.coreutilsProvenance))
    throw new Error("PRODUCT_PROGRAM_COREUTILS_PROVENANCE_PIN_INVALID");
  if (
    !Array.isArray(pins.gitTemplates.files) ||
    pins.gitTemplates.files.length !== 16 ||
    !Array.isArray(pins.gitTemplates.directories) ||
    pins.gitTemplates.directories.length !== 3 ||
    !isRecord(pins.gitTemplates.source) ||
    typeof pins.gitTemplates.source.archiveUrl !== "string" ||
    typeof pins.gitTemplates.source.archiveSha256 !== "string" ||
    !Number.isSafeInteger(pins.gitTemplates.source.archiveBytes)
  ) {
    throw new Error("PRODUCT_PROGRAM_GIT_TEMPLATE_PIN_SET_INVALID");
  }
  if (
    !isRecord(pins.gitBuild) ||
    typeof pins.gitBuild.recipeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pins.gitBuild.recipeSha256) ||
    typeof pins.gitBuild.image !== "string" ||
    !isRecord(pins.gitBuild.inputs)
  ) {
    throw new Error("PRODUCT_PROGRAM_GIT_BUILD_PIN_INVALID");
  }
  for (const file of pins.gitTemplates.files) {
    if (
      !safeRelative(file.sourceMember) ||
      !safeRelative(file.assetPath) ||
      !safeRelative(file.relativeInstallPath) ||
      file.path !== `/usr/share/git-core/templates/${file.relativeInstallPath}` ||
      file.assetPath !== `git-templates/files${file.path}` ||
      file.sourceMember !== `git-2.53.0/templates/${file.relativeInstallPath}` ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      ![0o644, 0o755].includes(file.mode)
    )
      throw new Error("PRODUCT_PROGRAM_GIT_TEMPLATE_PIN_INVALID");
  }
  for (const directory of pins.gitTemplates.directories) {
    if (!safeRelative(directory.assetPath) || directory.mode !== "0755")
      throw new Error("PRODUCT_PROGRAM_GIT_TEMPLATE_DIRECTORY_PIN_INVALID");
  }
  requireHttps(pins.gitTemplates.source.archiveUrl, "git-templates:source");
  if (
    !isRecord(pins.jqPackage) ||
    !safeRelative(pins.jqPackage.packagePath) ||
    !safeRelative(pins.jqPackage.packageEntry) ||
    !Array.isArray(pins.jqPackage.imports) ||
    !Array.isArray(pins.jqPackage.exports)
  ) {
    throw new Error("PRODUCT_PROGRAM_JQ_PACKAGE_PIN_INVALID");
  }
}

async function verifyWithPublicPreparer(repositoryRoot: string, programDirectory: string) {
  const entry = NodePath.join(
    repositoryRoot,
    "apps/cloud/infra/harnessReleases/productProgramInputs.ts",
  );
  const { stdout } = await execFile(
    process.execPath,
    ["--experimental-strip-types", entry, "--verify", programDirectory],
    {
      cwd: repositoryRoot,
      env: safeBuildEnvironment(),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("PRODUCT_PROGRAM_PREPARER_RESULT_INVALID", { cause });
  }
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error("PRODUCT_PROGRAM_PREPARER_RESULT_INVALID");
  return value as unknown as PreparedProductProgramShape;
}

function inside(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function validPin(value: unknown): value is Pin {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    safeRelative(value.file) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

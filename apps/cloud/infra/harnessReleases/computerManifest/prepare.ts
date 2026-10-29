import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as esbuild from "esbuild";
import type { ChildWorkerCode } from "../../../src/computer/ChildWorkerProgram.ts";
import { createMachineImageContentReader } from "../../../src/computer/MachineImageContent.ts";
import {
  validateMachineProgramInventory,
  type MachineProgramInventory,
} from "../../../src/computer/MachineProgramInventory.ts";
import {
  createChildProgramExecutableCatalog,
  prepareChildPrograms,
  type ChildProgramSourceCode,
  type PreparedChildPrograms,
} from "../../childPrograms/prepare.ts";
import { createSeededCommandProgramCodes } from "../../childPrograms/programCodes.ts";
import {
  assertSourceFreeze,
  canonicalComputerJson,
  compareText,
  computerSha256,
  createTrustedComputerIdentity,
  describePreparedAsset,
  describePreparedModules,
  type TrustedComputerIdentity,
  type TrustedComputerPreparedCommands,
  type TrustedComputerSourceFreeze,
} from "./identity.ts";
import { captureCurrentSourceFreeze } from "./sourceFreeze.ts";
import { verifyAndNormalizePreparedSourceInventory } from "./sourceInventory.ts";

const HEX_SHA256 = /^[a-f0-9]{64}$/u;

interface TrustedComputerPreparationInput {
  readonly programDirectory: string;
  readonly machineInventory: MachineProgramInventory;
}

export async function prepareTrustedComputerManifest(
  input: TrustedComputerPreparationInput,
): Promise<TrustedComputerIdentity> {
  return (await prepareTrustedComputerInputs(input)).identity;
}

export async function prepareTrustedComputerInputs(input: TrustedComputerPreparationInput) {
  const cloudRoot = NodePath.resolve(import.meta.dirname, "../../..");
  const repository = NodePath.resolve(cloudRoot, "../..");
  const sourceBefore = await captureCurrentSourceFreeze(repository);
  assertSourceFreeze(sourceBefore);
  const machineInventory = JSON.parse(
    JSON.stringify(input.machineInventory),
  ) as MachineProgramInventory;
  await validateMachineInventory(machineInventory);

  const programDirectory = await NodeFSP.realpath(input.programDirectory);
  const programDirectoryStat = await NodeFSP.lstat(programDirectory);
  if (programDirectoryStat.isSymbolicLink() || !programDirectoryStat.isDirectory())
    throw new Error("TRUSTED_COMPUTER_PROGRAM_DIRECTORY_INVALID");

  const prepared = await prepareChildPrograms({ programDir: programDirectory, cloudRoot });
  const commands = describePreparedCommands(prepared, sourceBefore);
  const identity = createTrustedComputerIdentity({
    source: sourceBefore,
    compilerVersions: {
      childProgramTypeStripper: {
        implementation: "node:module.stripTypeScriptTypes",
        node: process.version,
      },
      esbuild: { implementation: "esbuild", version: esbuild.version },
    },
    machineInventory,
    commands,
  });
  const sourceAfter = await captureCurrentSourceFreeze(repository);
  assertSourceFreeze(sourceAfter);
  if (sourceBefore.commit !== sourceAfter.commit || sourceBefore.sha256 !== sourceAfter.sha256)
    throw new Error("TRUSTED_COMPUTER_SOURCE_CHANGED");
  return { identity, prepared, machineInventory };
}

function describePreparedCommands(
  prepared: PreparedChildPrograms,
  sourceFreeze: TrustedComputerSourceFreeze,
): TrustedComputerPreparedCommands {
  const executableFiles = prepared.commandExecutableFiles.map(describePreparedAsset).sort(byPath);
  const dataFiles = prepared.dataFiles.map(describePreparedAsset).sort(byPath);
  const executableCatalog = createChildProgramExecutableCatalog(prepared.commandExecutableFiles);
  if (
    canonicalComputerJson(executableCatalog) !==
    canonicalComputerJson(prepared.commandExecutableCatalog)
  )
    throw new Error("TRUSTED_COMPUTER_COMMAND_CATALOG_DRIFT");

  const seeded = createSeededCommandProgramCodes(prepared.programs);
  const programDescriptors: Record<string, unknown> = {
    bash: describeProgram(seeded.bash, prepared.programs.bash, executableFiles),
    busyboxCat: describeProgram(seeded.busyboxCat, prepared.programs.busyboxCat, executableFiles),
    busyboxApplets: describeProgram(
      seeded.busyboxApplets,
      prepared.programs.busyboxApplets,
      executableFiles,
    ),
    productBusyboxApplets: describeProgram(
      seeded.productBusyboxApplets,
      prepared.programs.productBusyboxApplets,
      executableFiles,
    ),
    ripgrep: describeProgram(seeded.ripgrep, prepared.programs.ripgrep, executableFiles),
    git: describeProgram(seeded.git, prepared.programs.git, executableFiles),
    sed: describeProgram(seeded.sed, prepared.programs.sed, executableFiles),
    jq: describeProgram(seeded.jq, prepared.programs.jq, executableFiles),
    ugrep: describeProgram(seeded.ugrep, prepared.programs.ugrep, executableFiles),
    coreutils: Object.fromEntries(
      Object.entries(seeded.coreutils)
        .sort(([left], [right]) => compareText(left, right))
        .map(([command, code]) => [
          command,
          describeProgram(
            code,
            prepared.programs.coreutils[command as keyof typeof prepared.programs.coreutils],
            executableFiles,
          ),
        ]),
    ),
  };

  const assetKeys = new Set(
    [...executableFiles, ...dataFiles].map((file) => `${file.bytes}:${file.sha256}`),
  );
  const declaredAssetKeys = new Set(
    prepared.sourceInventory.artifacts.map((artifact) => `${artifact.bytes}:${artifact.sha256}`),
  );
  if ([...assetKeys].some((key) => !declaredAssetKeys.has(key)))
    throw new Error("TRUSTED_COMPUTER_ASSET_INVENTORY_DRIFT");
  for (const artifact of prepared.sourceInventory.artifacts) {
    if (!assetKeys.has(`${artifact.bytes}:${artifact.sha256}`))
      throw new Error(`TRUSTED_COMPUTER_ARTIFACT_UNBOUND: ${artifact.path}`);
  }
  const sourceInventory = verifyAndNormalizePreparedSourceInventory(prepared, sourceFreeze);

  const computedDataCatalog = Object.fromEntries(
    dataFiles.map((file) => [
      file.path,
      { bytes: file.bytes, sha256: file.sha256, mode: file.mode },
    ]),
  );
  if (canonicalComputerJson(computedDataCatalog) !== canonicalComputerJson(prepared.dataCatalog))
    throw new Error("TRUSTED_COMPUTER_DATA_CATALOG_DRIFT");

  return {
    sourceInventory,
    executableCatalog,
    executableFiles,
    dataCatalog: prepared.dataCatalog,
    dataFiles,
    programs: programDescriptors,
  };
}

function describeProgram(
  code: ChildWorkerCode,
  source: ChildProgramSourceCode,
  executableFiles: readonly { readonly bytes: number; readonly sha256: string }[],
) {
  const artifact = code.executableArtifact;
  if (
    !artifact ||
    !HEX_SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    !executableFiles.some(
      (file) => file.bytes === artifact.bytes && file.sha256 === artifact.sha256,
    )
  )
    throw new Error("TRUSTED_COMPUTER_PROGRAM_PIN_INVALID");
  if (source.modules["main.js"] === undefined)
    throw new Error("TRUSTED_COMPUTER_PROGRAM_SOURCE_MISSING");
  const modules = describePreparedModules(code);
  for (const module of modules) {
    if (
      "wasmReference" in module &&
      !executableFiles.some((file) => file.sha256 === module.wasmReference)
    )
      throw new Error("TRUSTED_COMPUTER_PROGRAM_REFERENCE_UNBOUND");
  }
  return {
    entrypoint: source.entrypoint,
    mainModule: code.mainModule,
    executableArtifact: artifact,
    modules,
  };
}

async function validateMachineInventory(inventory: MachineProgramInventory): Promise<void> {
  validateMachineProgramInventory(inventory);
  const content = inventory.imageContent;
  if (content === undefined) return;
  const reader = createMachineImageContentReader(inventory);
  const first = content.entries[0];
  if (first !== undefined) {
    const actual = await reader(first.path, 0, Number(first.size));
    if (actual === undefined || actual.byteLength !== Number(first.size))
      throw new Error("TRUSTED_COMPUTER_IMAGE_CONTENT_MISSING");
    return;
  }

  const { imageContent: _content, ...metadata } = inventory;
  if (
    content.format !== "signalbox-machine-image-content-v1" ||
    content.imageDigest !== inventory.imageDigest ||
    content.captureSha256 !== inventory.provenance.captureSha256 ||
    !HEX_SHA256.test(content.captureSha256) ||
    !HEX_SHA256.test(content.inventorySha256) ||
    !HEX_SHA256.test(inventory.provenance.snapshotSha256 ?? "") ||
    !Array.isArray(content.entries) ||
    content.includeRule !== "regular-files-under-/etc" ||
    content.fileCount !== 0 ||
    content.totalBytes !== 0 ||
    inventory.entries.some((entry) => entry.type === "file" && entry.path.startsWith("/etc/")) ||
    computerSha256(JSON.stringify(metadata)) !== content.inventorySha256
  )
    throw new Error("TRUSTED_COMPUTER_IMAGE_CONTENT_INVALID");
}

function byPath(left: { readonly path: string }, right: { readonly path: string }) {
  return compareText(left.path, right.path);
}

import * as NodeFSP from "node:fs/promises";
import type { CommandProgramCodes } from "../../../src/computer/CommandGateway.ts";
import {
  validateMachineProgramInventory,
  type MachineProgramInventory,
} from "../../../src/computer/MachineProgramInventory.ts";
import type { ProgramSeed } from "../../../src/harness/HarnessSessionHost.ts";
import { createSeededCommandProgramCodes } from "../../childPrograms/programCodes.ts";
import {
  canonicalComputerJson,
  computerSha256,
  prepareTrustedComputerInputs,
  type TrustedComputerIdentity,
} from "../computerManifest.ts";

export interface ClaudeQualificationComputerInputs {
  readonly trustedComputer: TrustedComputerIdentity["trustedComputer"];
  readonly machineInventory: MachineProgramInventory;
  readonly codes: CommandProgramCodes;
  readonly makeProgramSeed: (identity: {
    readonly uid: number;
    readonly gid: number;
  }) => ProgramSeed;
}

/** Reconstructs the public Computer inputs from the exact pair build inputs and checks their pins. */
export async function loadClaudeQualificationComputerInputs(input: {
  readonly computerManifestPath: string;
  readonly programsDirectory: string;
  readonly machineInventoryPath: string;
  readonly expectedTrustedComputer: TrustedComputerIdentity["trustedComputer"];
  readonly expectedSource: unknown;
}): Promise<ClaudeQualificationComputerInputs> {
  const raw = await readJsonFile(
    input.computerManifestPath,
    "CLAUDE_QUALIFICATION_COMPUTER_MANIFEST_INVALID",
  );
  const computer = record(raw, "CLAUDE_QUALIFICATION_COMPUTER_MANIFEST_INVALID");
  const trustedComputer = record(
    computer.trustedComputer,
    "CLAUDE_QUALIFICATION_COMPUTER_IDENTITY_INVALID",
  ) as unknown as TrustedComputerIdentity["trustedComputer"];
  const manifest = record(computer.manifest, "CLAUDE_QUALIFICATION_COMPUTER_MANIFEST_INVALID");
  const identityInputs = record(
    manifest.identityInputs,
    "CLAUDE_QUALIFICATION_COMPUTER_MANIFEST_INVALID",
  );
  const source = identityInputs.source;

  if (!same(trustedComputer, input.expectedTrustedComputer))
    throw new Error("CLAUDE_QUALIFICATION_COMPUTER_IDENTITY_MISMATCH");
  if (!same(source, input.expectedSource))
    throw new Error("CLAUDE_QUALIFICATION_SOURCE_FREEZE_MISMATCH");
  if (
    computerSha256(canonicalComputerJson(identityInputs)) !== trustedComputer.sourceIdentity ||
    computerSha256(canonicalComputerJson(manifest)) !== trustedComputer.manifestSha256
  )
    throw new Error("CLAUDE_QUALIFICATION_COMPUTER_MANIFEST_HASH_MISMATCH");

  const inventory = validateMachineProgramInventory(
    (await readJsonFile(
      input.machineInventoryPath,
      "CLAUDE_QUALIFICATION_MACHINE_INVENTORY_INVALID",
    )) as MachineProgramInventory,
  );
  if (!same(inventory, identityInputs.machineInventory))
    throw new Error("CLAUDE_QUALIFICATION_MACHINE_INVENTORY_MISMATCH");
  const verified = await prepareTrustedComputerInputs({
    programDirectory: input.programsDirectory,
    machineInventory: inventory,
  });
  if (!same(verified.identity.manifest, manifest))
    throw new Error("CLAUDE_QUALIFICATION_COMPUTER_INPUTS_MISMATCH");
  const { prepared } = verified;
  const codes = createSeededCommandProgramCodes(prepared.programs);

  const files = new Map<
    string,
    {
      readonly bytes: Uint8Array;
      readonly metadata: {
        readonly bytes: number;
        readonly sha256: string;
        readonly mode: number;
      };
    }
  >();
  for (const entry of [...prepared.commandExecutableFiles, ...prepared.dataFiles]) {
    if (files.has(entry.path)) throw new Error("CLAUDE_QUALIFICATION_PROGRAM_PATH_DUPLICATE");
    files.set(entry.path, {
      bytes: Uint8Array.from(entry.bytes),
      metadata: {
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
        mode: entry.mode,
      },
    });
  }

  return {
    trustedComputer,
    machineInventory: inventory,
    codes,
    makeProgramSeed: ({ uid, gid }) => ({
      sourceIdentity: trustedComputer.sourceIdentity,
      files: Object.fromEntries(
        [...files].map(([path, file]) => [path, { ...file.metadata, uid, gid }]),
      ),
      read: async (path, signal) => {
        signal.throwIfAborted();
        const file = files.get(path);
        if (file === undefined) throw new Error("CLAUDE_QUALIFICATION_PROGRAM_ASSET_MISSING");
        return Uint8Array.from(file.bytes);
      },
    }),
  };
}

async function readJsonFile(path: string, code: string): Promise<unknown> {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(code);
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(code, { cause });
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function same(left: unknown, right: unknown) {
  return canonicalComputerJson(left) === canonicalComputerJson(right);
}

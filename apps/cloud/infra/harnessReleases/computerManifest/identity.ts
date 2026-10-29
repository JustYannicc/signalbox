import * as NodeCrypto from "node:crypto";
import type {
  ChildWorkerCode,
  ChildWorkerModule,
} from "../../../src/computer/ChildWorkerProgram.ts";
import {
  validateMachineProgramInventory,
  type MachineProgramInventory,
} from "../../../src/computer/MachineProgramInventory.ts";
import type { PreparedChildPrograms } from "../../childPrograms/prepare.ts";

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;

export interface TrustedComputerSourceFile {
  readonly path: string;
  readonly executable: boolean;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TrustedComputerSourceFreeze {
  readonly commit: string;
  readonly sha256: string;
  readonly files: readonly TrustedComputerSourceFile[];
}

export interface TrustedComputerIdentityInputs {
  readonly source: TrustedComputerSourceFreeze;
  readonly compilerVersions: {
    readonly childProgramTypeStripper: {
      readonly implementation: "node:module.stripTypeScriptTypes";
      readonly node: string;
    };
    readonly esbuild: {
      readonly implementation: "esbuild";
      readonly version: string;
    };
  };
  readonly machineInventory: MachineProgramInventory;
  readonly commands: TrustedComputerPreparedCommands;
}

export interface TrustedComputerPreparedCommands {
  readonly sourceInventory: PreparedChildPrograms["sourceInventory"];
  readonly executableCatalog: PreparedChildPrograms["commandExecutableCatalog"];
  readonly executableFiles: readonly PreparedAssetDescriptor[];
  readonly dataCatalog: PreparedChildPrograms["dataCatalog"];
  readonly dataFiles: readonly PreparedAssetDescriptor[];
  readonly programs: Readonly<Record<string, unknown>>;
}

export interface PreparedAssetDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export type PreparedModuleDescriptor =
  | { readonly path: string; readonly bytes: number; readonly sha256: string }
  | { readonly path: string; readonly wasmReference: string };

export interface TrustedComputerManifest {
  readonly format: "signalbox-trusted-computer-manifest-v1";
  readonly identityInputs: TrustedComputerIdentityInputs;
  readonly sourceIdentity: string;
}

export interface TrustedComputerIdentity {
  readonly trustedComputer: {
    readonly sourceIdentity: string;
    readonly manifestSha256: string;
  };
  readonly manifest: TrustedComputerManifest;
}

export const computerSha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Canonical JSON uses lexically sorted object keys and preserves array order. */
export function canonicalComputerJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw new TypeError("COMPUTER_MANIFEST_NON_JSON_VALUE");
  return value;
}

/**
 * `sourceIdentity` hashes canonical identity inputs. `manifestSha256` hashes the canonical
 * manifest including that source identity. Neither hash represents runtime qualification.
 */
export function createTrustedComputerIdentity(
  identityInputs: TrustedComputerIdentityInputs,
): TrustedComputerIdentity {
  assertSourceFreeze(identityInputs.source);
  validateMachineProgramInventory(identityInputs.machineInventory);

  const sourceIdentity = computerSha256(canonicalComputerJson(identityInputs));
  const manifest: TrustedComputerManifest = {
    format: "signalbox-trusted-computer-manifest-v1",
    identityInputs,
    sourceIdentity,
  };
  const manifestSha256 = computerSha256(canonicalComputerJson(manifest));
  return {
    trustedComputer: { sourceIdentity, manifestSha256 },
    manifest,
  };
}

export function describePreparedAsset(file: {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
}): PreparedAssetDescriptor {
  if (!(file.bytes instanceof Uint8Array) || !HEX_SHA256.test(file.sha256))
    throw new Error("TRUSTED_COMPUTER_ASSET_DESCRIPTOR_INVALID");
  const bytes = file.bytes.byteLength;
  if (computerSha256(file.bytes) !== file.sha256)
    throw new Error(`TRUSTED_COMPUTER_ASSET_HASH_MISMATCH: ${file.path}`);
  if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o7777)
    throw new Error(`TRUSTED_COMPUTER_ASSET_MODE_INVALID: ${file.path}`);
  return { path: file.path, bytes, sha256: file.sha256, mode: file.mode };
}

export function describePreparedModules(
  code: ChildWorkerCode,
): readonly PreparedModuleDescriptor[] {
  const result = typeof code.modules === "function" ? code.modules() : code.modules;
  if (result instanceof Promise) throw new Error("TRUSTED_COMPUTER_ASYNC_MODULES_UNSUPPORTED");
  const modules = result;
  return Object.entries(modules)
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, module]) => describeModule(path, module));
}

function describeModule(path: string, module: ChildWorkerModule): PreparedModuleDescriptor {
  if (typeof module === "string") return describeTextModule(path, module);
  if (module && typeof module === "object" && "js" in module) {
    if (typeof module.js !== "string") throw new Error("COMPUTER_MODULE_SOURCE_INVALID");
    return describeTextModule(path, module.js);
  }
  if (
    module &&
    typeof module === "object" &&
    "wasmReference" in module &&
    typeof module.wasmReference === "string" &&
    HEX_SHA256.test(module.wasmReference)
  ) {
    return { path, wasmReference: module.wasmReference };
  }
  throw new Error(`TRUSTED_COMPUTER_MODULE_UNSUPPORTED: ${path}`);
}

function describeTextModule(path: string, source: string): PreparedModuleDescriptor {
  const bytes = new TextEncoder().encode(source);
  return { path, bytes: bytes.byteLength, sha256: computerSha256(bytes) };
}

export function assertSourceFreeze(source: TrustedComputerSourceFreeze): void {
  if (
    !source ||
    !SOURCE_COMMIT.test(source.commit) ||
    !HEX_SHA256.test(source.sha256) ||
    !Array.isArray(source.files) ||
    source.files.length === 0
  )
    throw new Error("TRUSTED_COMPUTER_SOURCE_FREEZE_INVALID");
  let previous = "";
  for (const file of source.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path <= previous ||
      typeof file.executable !== "boolean" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !HEX_SHA256.test(file.sha256)
    )
      throw new Error("TRUSTED_COMPUTER_SOURCE_FREEZE_INVALID");
    previous = file.path;
  }
  if (computerSha256(JSON.stringify(source.files)) !== source.sha256)
    throw new Error("TRUSTED_COMPUTER_SOURCE_FREEZE_INVALID");
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

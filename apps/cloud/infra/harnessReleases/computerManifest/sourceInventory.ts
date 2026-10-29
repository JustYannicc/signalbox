import {
  canonicalComputerJson,
  compareText,
  computerSha256,
  type TrustedComputerSourceFreeze,
} from "./identity.ts";
import type { ChildProgramSourceCode, PreparedChildPrograms } from "../../childPrograms/prepare.ts";

export function verifyAndNormalizePreparedSourceInventory(
  prepared: PreparedChildPrograms,
  sourceFreeze: TrustedComputerSourceFreeze,
) {
  const frozen = new Map(sourceFreeze.files.map((file) => [file.path, file]));
  const generated = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  const uniquePrograms = uniquePreparedPrograms(prepared.programs);
  const expectedProgramNames = {
    bash: prepared.programs.bash,
    busyboxCat: prepared.programs.busyboxCat,
    busyboxApplets: prepared.programs.busyboxApplets,
    productBusyboxApplets: prepared.programs.productBusyboxApplets,
    ripgrep: prepared.programs.ripgrep,
    coreutils: Object.values(prepared.programs.coreutils)[0]!,
    git: prepared.programs.git,
    sed: prepared.programs.sed,
    jq: prepared.programs.jq,
    ugrep: prepared.programs.ugrep,
  };
  const inventoryPrograms = prepared.sourceInventory.programs;
  if (
    Object.keys(inventoryPrograms).length !== Object.keys(expectedProgramNames).length ||
    Object.keys(expectedProgramNames).some((name) => {
      const source = expectedProgramNames[name as keyof typeof expectedProgramNames];
      const recorded = inventoryPrograms[name];
      return (
        recorded === undefined ||
        recorded.entrypoint !== source.entrypoint ||
        recorded.mainModule !== source.mainModule ||
        canonicalComputerJson(recorded.modules) !==
          canonicalComputerJson(Object.keys(source.modules).sort(compareText))
      );
    })
  )
    throw new Error("TRUSTED_COMPUTER_PROGRAM_INVENTORY_DRIFT");

  for (const [entrypoint, code] of uniquePrograms) {
    for (const [path, module] of Object.entries(code.modules)) {
      const source = moduleSource(module);
      const bytes = new TextEncoder().encode(source);
      const generatedPath = `generated/${entrypoint}/${path}`;
      const descriptor = { bytes: bytes.byteLength, sha256: computerSha256(bytes) };
      const previous = generated.get(generatedPath);
      if (
        previous &&
        (previous.bytes !== descriptor.bytes || previous.sha256 !== descriptor.sha256)
      )
        throw new Error(`TRUSTED_COMPUTER_GENERATED_SOURCE_CONFLICT: ${generatedPath}`);
      generated.set(generatedPath, descriptor);
    }
  }

  const generatedRecords = new Map(
    prepared.sourceInventory.sources
      .filter((source) => source.path.startsWith("generated/"))
      .map((source) => [source.path, source]),
  );
  if (generated.size !== generatedRecords.size)
    throw new Error("TRUSTED_COMPUTER_GENERATED_INVENTORY_DRIFT");
  for (const [path, expected] of generated) {
    const actual = generatedRecords.get(path);
    if (
      actual === undefined ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      throw new Error(`TRUSTED_COMPUTER_GENERATED_INVENTORY_DRIFT: ${path}`);
  }

  for (const source of prepared.sourceInventory.sources) {
    if (source.path.startsWith("generated/")) continue;
    const current = frozen.get(`apps/cloud/${source.path}`);
    if (current === undefined || current.bytes !== source.bytes || current.sha256 !== source.sha256)
      throw new Error(`TRUSTED_COMPUTER_SOURCE_INVENTORY_DRIFT: ${source.path}`);
  }

  return {
    format: prepared.sourceInventory.format,
    sources: [...prepared.sourceInventory.sources].sort(byPath),
    artifacts: [...prepared.sourceInventory.artifacts].sort(byPath),
    programs: Object.fromEntries(
      Object.entries(inventoryPrograms)
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, program]) => [
          name,
          { ...program, modules: [...program.modules].sort(compareText) },
        ]),
    ),
  };
}

function uniquePreparedPrograms(programs: PreparedChildPrograms["programs"]) {
  const values = [
    programs.bash,
    programs.busyboxCat,
    programs.busyboxApplets,
    programs.productBusyboxApplets,
    programs.ripgrep,
    Object.values(programs.coreutils)[0]!,
    programs.git,
    programs.sed,
    programs.jq,
    programs.ugrep,
  ];
  const unique = new Map<string, ChildProgramSourceCode>();
  for (const code of values) {
    if (!code.entrypoint) throw new Error("TRUSTED_COMPUTER_PROGRAM_ENTRYPOINT_MISSING");
    unique.set(code.entrypoint, code);
  }
  return unique;
}

function moduleSource(module: string | { readonly js: string }): string {
  if (typeof module === "string") return module;
  if (module && typeof module.js === "string") return module.js;
  throw new Error("TRUSTED_COMPUTER_MODULE_SOURCE_INVALID");
}

function byPath(left: { readonly path: string }, right: { readonly path: string }) {
  return compareText(left.path, right.path);
}

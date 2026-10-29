import type { ProductProgramPinSnapshot } from "./productProgramTypes.ts";

export interface PreparedProductProgramShape {
  readonly schemaVersion: 1;
  readonly commandExecutablePathCount: number;
  readonly commandExecutablePaths: readonly string[];
  readonly gitTemplateFileCount: number;
  readonly programs: readonly string[];
  readonly coreutils: readonly string[];
}

export function assertPreparedShape(
  prepared: PreparedProductProgramShape,
  pins: Pick<ProductProgramPinSnapshot, "commandExecutablePaths" | "gitTemplates" | "coreutils">,
): void {
  const requiredPrograms = [
    "bash",
    "busyboxCat",
    "busyboxApplets",
    "productBusyboxApplets",
    "ripgrep",
    "coreutils",
    "git",
    "sed",
    "jq",
    "ugrep",
  ];
  if (
    prepared.commandExecutablePathCount !== pins.commandExecutablePaths.length ||
    !sameEntries(prepared.commandExecutablePaths, pins.commandExecutablePaths) ||
    prepared.gitTemplateFileCount !== pins.gitTemplates.files.length ||
    !sameEntries(prepared.programs, requiredPrograms) ||
    !sameEntries(prepared.coreutils, Object.keys(pins.coreutils.commands))
  )
    throw new Error("PRODUCT_PROGRAM_PREPARER_SHAPE_MISMATCH");
}

function sameEntries(actual: readonly string[], expected: readonly string[]) {
  return (
    Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

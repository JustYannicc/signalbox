import {
  CHILD_PROGRAM_CODE_NAMES,
  type ChildProgramCodes,
} from "../../src/computer/ChildProgramCodes.ts";
import type { ChildProgramSourceCode } from "./packageGraph.ts";

type PreparedProgramSources = {
  readonly [Name in Exclude<keyof ChildProgramCodes, "coreutils">]?: ChildProgramSourceCode;
} & { readonly coreutils: Readonly<Record<string, ChildProgramSourceCode>> };

/** Coreutils shares one source graph; its executable descriptors still pin each command separately. */
export function preparedProgramEntries(programs: PreparedProgramSources) {
  return CHILD_PROGRAM_CODE_NAMES.map((name): [string, ChildProgramSourceCode] => {
    const key = name as keyof ChildProgramCodes;
    const code = key === "coreutils" ? Object.values(programs.coreutils)[0] : programs[key];
    if (code === undefined) throw new Error(`Prepared child program is missing ${name}`);
    return [name, code];
  });
}

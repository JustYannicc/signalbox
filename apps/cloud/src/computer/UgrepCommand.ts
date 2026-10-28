import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import { childProgramName, standardChildProgramName } from "./ChildProgramPaths.ts";
import { CHILD_UGREP_EXECUTABLES } from "./ChildProgramSet.ts";
import { machine, QUALIFIED, type GnuCommandQualification } from "./gnu/CommandQualification.ts";

/** Subprocess, terminal, compression and file-search modes remain machine work. */
export function qualifyUgrepCommand(command: KernelCommand): GnuCommandQualification | undefined {
  const program =
    standardChildProgramName(command.executable) ??
    (CHILD_UGREP_EXECUTABLES.some((path) => path === command.executable)
      ? childProgramName(command.executable)
      : undefined);
  if (program !== "ugrep" && program !== "claude") return undefined;
  if (program === "claude" && command.argv[0] !== "ugrep")
    return machine("unqualified-option", "Only the ugrep multicall entry is an isolate program");

  let pattern = false;
  let options = true;
  for (let index = 1; index < command.argv.length; index++) {
    const argument = command.argv[index]!;
    if (options && argument === "--") {
      options = false;
    } else if (
      options &&
      (argument === "--ignore-files" ||
        argument === "--hidden" ||
        (argument.startsWith("--exclude-dir=") && argument.length > "--exclude-dir=".length))
    ) {
      continue;
    } else if (options && argument.startsWith("-") && argument !== "-") {
      if (/^-[GEinI]+$/.test(argument)) continue;
      if (/^-A\d{1,3}$/.test(argument) && Number(argument.slice(2)) <= 100) continue;
      return machine("unqualified-option", `ugrep option ${argument} is outside the stdin subset`);
    } else if (pattern) {
      return machine("unqualified-script", "Only stdin-only ugrep with one pattern is qualified");
    } else {
      pattern = true;
    }
  }
  return pattern ? QUALIFIED : machine("unqualified-script", "ugrep needs one explicit pattern");
}

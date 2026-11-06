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
  if (program === "grep") return qualifyGrepCommand(command);
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

function qualifyGrepCommand(command: KernelCommand): GnuCommandQualification {
  if (command.argv[0] !== "grep") {
    return machine("unqualified-option", "The ugrep grep entry requires argv[0] to be grep");
  }
  let options = true;
  let pattern = false;
  let recursive = false;
  let files = 0;
  let dotRoot = false;
  for (let index = 1; index < command.argv.length; index++) {
    const argument = command.argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const option = equals < 0 ? argument : argument.slice(0, equals);
      if (option !== "--include" && option !== "--exclude-dir") {
        return machine(
          "unqualified-option",
          "GNU grep option " + option + " is outside the isolate subset",
        );
      }
      const value = equals < 0 ? command.argv[++index] : argument.slice(equals + 1);
      if (value === undefined || value.length === 0) {
        return machine("unqualified-option", "GNU grep " + option + " needs a nonempty pattern");
      }
      continue;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      if (!/^-[GEinvr]+$/.test(argument)) {
        return machine(
          "unqualified-option",
          "GNU grep option " + argument + " is outside the isolate subset",
        );
      }
      recursive ||= argument.includes("r");
      continue;
    }
    if (!pattern) {
      pattern = true;
    } else {
      files++;
      dotRoot ||= argument === ".";
    }
  }
  if (!pattern) return machine("unqualified-script", "GNU grep needs one explicit pattern");
  if (recursive && files === 0) {
    return machine("unqualified-script", "Recursive GNU grep needs an explicit directory operand");
  }
  if (recursive && dotRoot && files > 1) {
    return machine(
      "unqualified-script",
      "Recursive GNU grep from . with other operands cannot preserve isolate path output",
    );
  }
  return QUALIFIED;
}

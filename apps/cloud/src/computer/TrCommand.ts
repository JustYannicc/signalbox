import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import { childProgramName, standardChildProgramName } from "./ChildProgramPaths.ts";
import { machine, QUALIFIED, type GnuCommandQualification } from "./gnu/CommandQualification.ts";
import { inspectTrSet } from "./gnu/TrSet.ts";

export function qualifyTrCommand(command: KernelCommand): GnuCommandQualification | undefined {
  const name = standardChildProgramName(command.executable);
  if ((name === "tr" || name === "yes") && childProgramName(command.argv[0] ?? "") !== name)
    return machine(
      "unqualified-option",
      `The BusyBox ${name} entry requires argv[0] to name ${name}`,
    );
  if (name === "yes") {
    return command.argv.slice(1).some((arg) => arg.startsWith("-") && arg !== "-")
      ? machine("unqualified-option", "GNU yes options are outside the BusyBox literal subset")
      : QUALIFIED;
  }
  if (name !== "tr") return undefined;
  const locales = ["LC_CTYPE", "LC_COLLATE"].map(
    (key) => command.env.LC_ALL || command.env[key] || command.env.LANG || "C",
  );
  if (locales.some((locale) => locale !== "C" && locale !== "POSIX"))
    return machine("unqualified-option", "tr locale is outside the qualified C/POSIX byte subset");
  const flags = new Set<string>();
  const operands: string[] = [];
  let options = true;
  for (const arg of command.argv.slice(1)) {
    if (arg === "--" && operands.length > 0)
      return machine("unqualified-option", "tr '--' after SET1 needs GNU operand parsing");
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-") && arg !== "-") {
      if (operands.length > 0 || !/^-[cds]+$/.test(arg))
        return machine(
          "unqualified-option",
          `GNU tr option ${arg} is outside the qualified -c/-d/-s subset`,
        );
      for (const flag of arg.slice(1)) flags.add(flag);
    } else operands.push(arg);
  }
  const deleting = flags.has("d");
  const squeezing = flags.has("s");
  const count = deleting ? (squeezing ? 2 : 1) : squeezing && operands.length === 1 ? 1 : 2;
  if (operands.length !== count || (count === 2 && operands[1] === ""))
    return machine("unqualified-script", "GNU tr needs valid SET1/SET2 operands for this mode");
  const sets = operands.map(inspectTrSet);
  if (sets.some((set) => set === undefined))
    return machine(
      "incompatible-option",
      "tr set uses a construct outside the qualified byte/range/class/escape subset",
    );
  if (!deleting && flags.has("c") && (sets[0]?.classNames.length ?? 0) > 0 && !sets[1]?.singleByte)
    return machine(
      "incompatible-option",
      "GNU tr complemented classes require one output byte in the qualified subset",
    );
  if ((sets[1]?.classNames.length ?? 0) > 0) {
    const casePair =
      (operands[0] === "[:upper:]" && operands[1] === "[:lower:]") ||
      (operands[0] === "[:lower:]" && operands[1] === "[:upper:]");
    if (!deleting && (!casePair || flags.has("c")))
      return machine(
        "incompatible-option",
        "GNU tr translation classes in SET2 require a qualified upper/lower pair",
      );
  }
  return QUALIFIED;
}

import { simpleSedScript } from "./CommandPatterns.ts";
import { machine, QUALIFIED, type GnuCommandQualification } from "./CommandQualification.ts";

export function qualifySed(
  argv: readonly string[],
  isRegularFile?: (file: string) => boolean,
): GnuCommandQualification {
  let options = true;
  let extended = false;
  let inPlace = false;
  const scripts: string[] = [];
  const operands: string[] = [];

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      return argument === "--sandbox"
        ? machine("incompatible-option", "GNU sed --sandbox is not supported by the local applet")
        : machine(
            "unqualified-option",
            `GNU sed option ${argument.split("=", 1)[0]} is outside the qualified set`,
          );
    }
    if (!options || !argument.startsWith("-") || argument === "-") {
      operands.push(argument);
      continue;
    }

    const body = argument.slice(1);
    for (let cursor = 0; cursor < body.length; cursor++) {
      const option = body[cursor]!;
      if (option === "i") {
        if (inPlace)
          return machine(
            "unqualified-option",
            "Repeated sed -i options are outside the qualified set",
          );
        const suffix = body.slice(cursor + 1);
        // GNU expands stars in backup names; BusyBox appends the suffix literally.
        if (suffix !== "" && !/^[A-Za-z0-9._-]+$/.test(suffix)) {
          return machine("unqualified-option", "Only literal sed backup suffixes are qualified");
        }
        if (suffix === "" && argv[index + 1] === "") {
          return machine(
            "incompatible-option",
            "GNU sed treats a separate empty operand after -i as the script",
          );
        }
        inPlace = true;
        break;
      }
      if (option === "e" || option === "f") {
        const attached = body.slice(cursor + 1);
        const value = attached.length > 0 ? attached : argv[++index];
        if (value === undefined)
          return machine("unqualified-option", `GNU sed -${option} is missing its value`);
        if (option === "f")
          return machine(
            "unqualified-script",
            "Scripts loaded from sed -f are not inspected by this pure classifier",
          );
        scripts.push(value);
        break;
      }
      if (option === "E" || option === "r") extended = true;
      else if (option !== "n")
        return machine(
          "unqualified-option",
          `GNU sed short option -${option} is outside the qualified set`,
        );
    }
  }

  if (scripts.length === 0 && operands.length > 0) scripts.push(operands.shift()!);
  if (scripts.length === 0 || (!inPlace && scripts.length !== 1)) {
    return machine("unqualified-script", "Only one explicit non-editing sed script is qualified");
  }
  if (operands.length === 0 || operands.some((file) => file === "-" || file === "")) {
    return machine(
      "unqualified-script",
      "Sed needs named file operands in the qualified child subset",
    );
  }
  if (!scripts.every((script) => simpleSedScript(script, extended))) {
    return machine(
      "unqualified-script",
      "GNU sed script is outside the qualified print/substitution subset",
    );
  }
  // GNU rejects devices and directories instead of replacing them with temp files.
  if (inPlace && isRegularFile !== undefined && !operands.every(isRegularFile)) {
    return machine("unqualified-script", "In-place sed requires existing regular file targets");
  }
  return QUALIFIED;
}

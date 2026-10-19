import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import {
  isPrintableAscii,
  simpleBasicPattern,
  simpleExtendedPattern,
  simpleSedScript,
} from "./gnu/CommandPatterns.ts";

export type GnuCommandMachineReason =
  | "incompatible-option"
  | "unqualified-option"
  | "unqualified-script";

export type GnuCommandQualification =
  | { readonly kind: "qualified-isolate" }
  | GnuCommandMachineDecision;

interface GnuCommandMachineDecision {
  readonly kind: "machine";
  readonly reason: GnuCommandMachineReason;
  readonly detail: string;
}

const QUALIFIED = Object.freeze({ kind: "qualified-isolate" as const });
const TARGETS = new Map<string, "sed" | "grep">([
  ["sed", "sed"],
  ["/bin/sed", "sed"],
  ["grep", "grep"],
  ["/bin/grep", "grep"],
]);

/** Qualify only the narrow sed/grep argument subset supported by this classifier. */
export function qualifyGnuCommand(command: KernelCommand): GnuCommandQualification {
  const program = TARGETS.get(command.executable);
  if (program === undefined) return QUALIFIED;

  const environmentIssue = unqualifiedEnvironment(command.env, program);
  if (environmentIssue !== undefined) return machine("unqualified-option", environmentIssue);

  return program === "sed" ? qualifySed(command.argv) : qualifyGrep(command.argv);
}

function qualifyGrep(argv: readonly string[]): GnuCommandQualification {
  const patterns: string[] = [];
  const flags = { fixed: false, extended: false };
  let options = true;
  let fileCount = 0;

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      const option = argument.split("=", 1)[0]!;
      if (option === "--include" || option === "--exclude-dir") {
        return machine(
          "incompatible-option",
          `GNU grep ${option} is not supported by the local applet`,
        );
      }
      return machine(
        "unqualified-option",
        `GNU grep option ${option} is outside the qualified set`,
      );
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      const parsed = parseGrepShortOptions(argv, index, patterns, flags);
      if (parsed.kind === "machine") return parsed;
      index = parsed.lastConsumed;
      continue;
    }

    if (patterns.length === 0) patterns.push(argument);
    else {
      if (argument === "-") {
        return machine(
          "unqualified-script",
          "Grep stdin operands have not been qualified through the child stream",
        );
      }
      fileCount++;
    }
  }

  if (flags.fixed && flags.extended) {
    return machine("unqualified-option", "GNU grep combines -F and -E outside the qualified set");
  }
  if (patterns.length !== 1) {
    return machine("unqualified-script", "Only one explicit grep pattern is qualified");
  }
  if (fileCount === 0) {
    return machine(
      "unqualified-script",
      "Stdin-only grep has not been qualified through the child stream",
    );
  }

  const pattern = patterns[0]!;
  const safe = flags.fixed
    ? isPrintableAscii(pattern)
    : flags.extended
      ? simpleExtendedPattern(pattern) !== undefined
      : simpleBasicPattern(pattern);
  return safe
    ? QUALIFIED
    : machine("unqualified-script", "GNU grep pattern is outside the qualified literal/ERE subset");
}

function parseGrepShortOptions(
  argv: readonly string[],
  optionIndex: number,
  patterns: string[],
  flags: { fixed: boolean; extended: boolean },
): { readonly kind: "parsed"; readonly lastConsumed: number } | GnuCommandMachineDecision {
  const argument = argv[optionIndex]!;
  const body = argument.slice(1);
  let cursor = 0;
  let lastConsumed = optionIndex;

  while (cursor < body.length) {
    const option = body[cursor]!;
    cursor++;
    if (option === "P") {
      return machine("incompatible-option", "GNU grep -P requires GNU PCRE behavior");
    }
    if (option === "e" || option === "f") {
      const attached = body.slice(cursor);
      const value = attached.length > 0 ? attached : argv[optionIndex + 1];
      if (value === undefined) {
        return machine("unqualified-option", `GNU grep -${option} is missing its value`);
      }
      if (attached.length === 0) lastConsumed++;
      if (option === "f") {
        return machine(
          "unqualified-script",
          "Patterns loaded from grep -f are not inspected by this pure classifier",
        );
      }
      patterns.push(value);
      return { kind: "parsed", lastConsumed };
    }
    if (option === "A" || option === "B" || option === "C") {
      const attached = body.slice(cursor);
      const value = attached.length > 0 ? attached : argv[optionIndex + 1];
      if (value === undefined || !smallContextCount(value)) {
        return machine(
          "unqualified-option",
          `GNU grep -${option} needs a small decimal context value`,
        );
      }
      if (attached.length === 0) lastConsumed++;
      return { kind: "parsed", lastConsumed };
    }
    switch (option) {
      case "n":
      case "q":
      case "r":
      case "i":
        break;
      case "E":
        flags.extended = true;
        break;
      case "F":
        flags.fixed = true;
        break;
      default:
        return machine(
          "unqualified-option",
          `GNU grep short option -${option} is outside the qualified set`,
        );
    }
  }

  return { kind: "parsed", lastConsumed };
}

function qualifySed(argv: readonly string[]): GnuCommandQualification {
  let options = true;
  let extended = false;
  let inPlace = false;
  const scripts: string[] = [];
  let fileCount = 0;

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      if (argument === "--sandbox") {
        return machine(
          "incompatible-option",
          "GNU sed --sandbox is not supported by the local applet",
        );
      }
      return machine(
        "unqualified-option",
        `GNU sed option ${argument.split("=", 1)[0]} is outside the qualified set`,
      );
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      if (argument.startsWith("-i")) {
        if (argument === "-i" && argv[index + 1] === "") {
          return machine(
            "incompatible-option",
            "GNU sed treats a separate empty operand after -i as the script",
          );
        }
        if (argument !== "-i") {
          return machine(
            "unqualified-option",
            "In-place backup suffixes are outside the qualified set",
          );
        }
        inPlace = true;
        continue;
      }
      if (argument.startsWith("-e") || argument.startsWith("-f")) {
        const option = argument[1]!;
        const attached = argument.slice(2);
        const value = attached.length > 0 ? attached : argv[index + 1];
        if (value === undefined) {
          return machine("unqualified-option", `GNU sed -${option} is missing its value`);
        }
        if (attached.length === 0) index++;
        if (option === "f") {
          return machine(
            "unqualified-script",
            "Scripts loaded from sed -f are not inspected by this pure classifier",
          );
        }
        scripts.push(value);
        continue;
      }
      for (const option of argument.slice(1)) {
        if (option === "E" || option === "r") extended = true;
        else if (option !== "n") {
          return machine(
            "unqualified-option",
            `GNU sed short option -${option} is outside the qualified set`,
          );
        }
      }
      continue;
    }

    if (scripts.length === 0) scripts.push(argument);
    else {
      if (argument === "-") {
        return machine(
          "unqualified-script",
          "Sed stdin operands have not been qualified through the child stream",
        );
      }
      fileCount++;
    }
  }

  if (inPlace) {
    return machine("unqualified-option", "In-place sed file effects are outside the qualified set");
  }
  if (scripts.length !== 1) {
    return machine("unqualified-script", "Only one explicit sed script is qualified");
  }
  if (fileCount === 0) {
    return machine(
      "unqualified-script",
      "Stdin-only sed has not been qualified through the child stream",
    );
  }
  return simpleSedScript(scripts[0]!, extended)
    ? QUALIFIED
    : machine(
        "unqualified-script",
        "GNU sed script is outside the qualified print/substitution subset",
      );
}

function smallContextCount(value: string): boolean {
  if (value.length === 0 || value.length > 3) return false;
  let number = 0;
  for (const character of value) {
    if (!isDigit(character)) return false;
    number = number * 10 + Number(character);
  }
  return number <= 100;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function unqualifiedEnvironment(
  env: Readonly<Record<string, string>>,
  program: "sed" | "grep",
): string | undefined {
  if (program === "grep" && Object.hasOwn(env, "GREP_OPTIONS")) {
    return "GREP_OPTIONS can change GNU grep parsing and is outside the qualified environment";
  }
  if (Object.hasOwn(env, "POSIXLY_CORRECT")) {
    return "POSIXLY_CORRECT can change option semantics and is outside the qualified environment";
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      (key === "LANG" || key === "LANGUAGE" || key.startsWith("LC_")) &&
      value !== "" &&
      value !== "C" &&
      value !== "POSIX"
    ) {
      return `${key}=${value} changes locale-sensitive matching outside the qualified environment`;
    }
  }
  return undefined;
}

function machine(reason: GnuCommandMachineReason, detail: string): GnuCommandMachineDecision {
  return { kind: "machine", reason, detail };
}

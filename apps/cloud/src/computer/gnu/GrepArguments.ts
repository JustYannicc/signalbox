import { machine, type GnuCommandMachineDecision } from "./CommandQualification.ts";

interface GrepArguments {
  readonly kind: "parsed";
  readonly flags: ReadonlySet<string>;
  readonly operandIndexes: readonly number[];
}

/** Shared with the path-label adapter so option values never become recursive roots. */
export function parseGrepArguments(
  argv: readonly string[],
): GrepArguments | GnuCommandMachineDecision {
  if (argv[0] !== "grep") {
    return machine("unqualified-option", "The ugrep grep entry requires argv[0] to be grep");
  }
  let options = true;
  const flags = new Set<string>();
  const patterns: string[] = [];
  const operandIndexes: number[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      if (argument === "--color=never") continue;
      const equals = argument.indexOf("=");
      const option = equals < 0 ? argument : argument.slice(0, equals);
      if (!["--include", "--exclude", "--exclude-dir", "--max-count"].includes(option)) {
        return machine(
          "unqualified-option",
          `GNU grep option ${option} is outside the isolate subset`,
        );
      }
      const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined || value.length === 0) {
        return machine("unqualified-option", `GNU grep ${option} needs a nonempty argument`);
      }
      if (option === "--max-count") {
        const failure = qualifyCount(value, "m");
        if (failure !== undefined) return failure;
        flags.add("m");
      } else {
        // Ugrep's slash/globstar filters use gitignore path rules, not GNU basename rules.
        if (option !== "--exclude-dir" && (value.includes("/") || value.includes("**"))) {
          return machine("incompatible-option", "GNU grep pathname globs differ from ugrep");
        }
        flags.add(option);
      }
      continue;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      for (let cursor = 1; cursor < argument.length; cursor++) {
        const option = argument[cursor]!;
        if ("meABC".includes(option)) {
          const attached = argument.slice(cursor + 1);
          const value = attached.length > 0 ? attached : argv[++index];
          if (value === undefined) {
            return machine("unqualified-option", `GNU grep -${option} needs an argument`);
          }
          if (option === "e") patterns.push(value);
          else {
            const failure = qualifyCount(value, option);
            if (failure !== undefined) return failure;
            flags.add(option);
          }
          break;
        }
        if (option === "P") {
          return machine("incompatible-option", "GNU grep -P requires GNU PCRE behavior");
        }
        if (!"GEilnvrochHwxqsF".includes(option)) {
          return machine(
            "unqualified-option",
            `GNU grep option -${option} is outside the isolate subset`,
          );
        }
        flags.add(option);
      }
      continue;
    }
    operandIndexes.push(index);
  }
  if (patterns.length === 0) {
    const patternIndex = operandIndexes.shift();
    if (patternIndex === undefined) {
      return machine("unqualified-script", "GNU grep needs one explicit pattern");
    }
    patterns.push(argv[patternIndex]!);
  }
  if (flags.has("r") && operandIndexes.length === 0) {
    return machine("unqualified-script", "Recursive GNU grep needs an explicit directory operand");
  }
  // Ugrep 7.5.0 counts occurrences with -co and treats -o context as columns, not lines.
  if (flags.has("o") && ["c", "v", "A", "B", "C"].some((flag) => flags.has(flag))) {
    return machine(
      "incompatible-option",
      "GNU grep -o count, invert and context combinations differ from ugrep",
    );
  }
  if (["G", "E", "F"].filter((flag) => flags.has(flag)).length > 1) {
    return machine("incompatible-option", "GNU grep conflicting matchers differ from ugrep");
  }
  if (flags.has("h") && flags.has("H")) {
    return machine("incompatible-option", "GNU grep filename flag precedence differs from ugrep");
  }
  if (flags.has("--include") && flags.has("--exclude")) {
    return machine("incompatible-option", "GNU grep include/exclude precedence differs from ugrep");
  }
  // Ugrep -q also implies -s, and unlike GNU it retains errors seen before a later match.
  if (flags.has("q") && (!flags.has("s") || flags.has("r") || operandIndexes.length > 1)) {
    return machine("incompatible-option", "GNU grep quiet error handling differs from ugrep");
  }
  if (!flags.has("F") && patterns.some(hasUnqualifiedEscape)) {
    return machine(
      "unqualified-script",
      "GNU grep backreferences and regex escapes need the machine matcher",
    );
  }
  // The ./ label format cannot preserve line context, or -m's line count with ungrouped -o.
  if (
    flags.has("r") &&
    operandIndexes.some((index) => argv[index] === ".") &&
    (["A", "B", "C"].some((flag) => flags.has(flag)) || (flags.has("o") && flags.has("m")))
  ) {
    return machine(
      "incompatible-option",
      "GNU grep recursive dot-root output is outside the isolate subset",
    );
  }
  return { kind: "parsed", flags, operandIndexes };
}

function qualifyCount(value: string, option: string) {
  if (!/^\d+$/.test(value) || Number(value) > 0xffff_ffff) {
    return machine("unqualified-option", `GNU grep -${option} needs a decimal count`);
  }
  if (option === "m") {
    // Ugrep uses zero for unlimited matches; GNU -m0 selects nothing.
    if (Number(value) === 0)
      return machine("incompatible-option", "GNU grep -m0 differs from ugrep");
  } else if (Number(value) > 100) {
    return machine("unqualified-option", `GNU grep -${option} needs at most 100 context lines`);
  }
}

function hasUnqualifiedEscape(pattern: string) {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "\\") continue;
    const escaped = pattern[++index] ?? "";
    if (/[A-Za-z0-9]/.test(escaped) && !"bBwWsS".includes(escaped)) return true;
  }
  return false;
}

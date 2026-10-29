export const CLAUDE_BASH_WRAPPER_TEMPLATE_ID = "claude-bash-shopt-eval-pwd-v1";

const wrapperPrefix =
  "shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval ";
const wrapperSuffixPrefix = " < /dev/null && pwd -P >| ";
const outputPath = /^\/tmp\/[A-Za-z0-9._-]+$/;

export interface ClaudeBashWrapperMatch {
  readonly templateId: typeof CLAUDE_BASH_WRAPPER_TEMPLATE_ID;
  readonly command: string;
  readonly operandSpan: {
    readonly argvIndex: 3;
    readonly start: number;
    readonly end: number;
    readonly unit: "utf16-code-units";
  };
}

export type ClaudeBashWrapperResult =
  | { readonly kind: "matched"; readonly value: ClaudeBashWrapperMatch }
  | { readonly kind: "gap"; readonly reason: string };

/** Recognizes only the retained Claude `bash -c -l` shell-state wrapper. */
export function extractClaudeBashWrapper(
  executable: string,
  argv: readonly string[],
): ClaudeBashWrapperResult {
  if (executable !== "/bin/bash" || argv.length !== 4 || argv[1] !== "-c" || argv[2] !== "-l") {
    return { kind: "gap", reason: "unsupported-wrapper-argv" };
  }
  const script = argv[3];
  if (typeof script !== "string") return { kind: "gap", reason: "missing-wrapper-script" };
  if (!script.startsWith(wrapperPrefix))
    return { kind: "gap", reason: "unsupported-wrapper-prefix" };

  const operandStart = wrapperPrefix.length;
  const operand = parseShellQuotedOperand(script, operandStart);
  if (operand.kind === "gap") return operand;
  const suffix = script.slice(operand.end);
  if (
    !suffix.startsWith(wrapperSuffixPrefix) ||
    !outputPath.test(suffix.slice(wrapperSuffixPrefix.length))
  ) {
    return { kind: "gap", reason: "unsupported-wrapper-suffix" };
  }
  return {
    kind: "matched",
    value: {
      templateId: CLAUDE_BASH_WRAPPER_TEMPLATE_ID,
      command: operand.value,
      operandSpan: {
        argvIndex: 3,
        start: operandStart,
        end: operand.end,
        unit: "utf16-code-units",
      },
    },
  };
}

type ParsedOperand =
  | { readonly kind: "matched"; readonly value: string; readonly end: number }
  | { readonly kind: "gap"; readonly reason: string };

function parseShellQuotedOperand(script: string, start: number): ParsedOperand {
  let index = start;
  let quote: "'" | '"' | undefined;
  let sawQuote = false;
  let value = "";

  while (index < script.length) {
    const char = script[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else value += char;
      index++;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        index++;
        continue;
      }
      if (char === "\\") {
        const next = script[index + 1];
        if (next === undefined) return { kind: "gap", reason: "unparseable-shell-quote" };
        if (next === "\n") {
          index += 2;
          continue;
        }
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          value += next;
        } else {
          value += `\\${next}`;
        }
        index += 2;
        continue;
      }
      if (char === "$" || char === "`") {
        return { kind: "gap", reason: "unsupported-shell-expansion" };
      }
      value += char;
      index++;
      continue;
    }

    if (isOperandDelimiter(char)) break;
    if (char === "'" || char === '"') {
      quote = char;
      sawQuote = true;
      index++;
      continue;
    }
    if (char === "\\") {
      const next = script[index + 1];
      if (next === undefined) return { kind: "gap", reason: "unparseable-shell-quote" };
      if (next !== "\n") value += next;
      index += 2;
      continue;
    }
    if (char === "$" && script[index + 1] === "'") {
      return { kind: "gap", reason: "unsupported-ansi-c-quote" };
    }
    if (char === "$" || char === "`") {
      return { kind: "gap", reason: "unsupported-shell-expansion" };
    }
    return { kind: "gap", reason: "operand-not-shell-quoted" };
  }

  if (quote !== undefined) return { kind: "gap", reason: "unparseable-shell-quote" };
  if (!sawQuote) return { kind: "gap", reason: "operand-not-shell-quoted" };
  return { kind: "matched", value, end: index };
}

function isOperandDelimiter(char: string): boolean {
  return /[\t\n\r ;&|()<>{}]/.test(char);
}

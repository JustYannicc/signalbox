interface SourceFunction {
  toString(): string;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "case",
  "delete",
  "else",
  "in",
  "instanceof",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const OPERATORS = [
  "===",
  "!==",
  ">>>",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**",
  "<<",
  ">>",
  "=",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
];

const nextNonWhitespace = (source: string, from: number) => {
  let index = from;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  return index;
};

/** Keep generated workflow lines stable when Node and Vite print a function differently. */
export const workflowFunctionSource = (fn: SourceFunction) => {
  const source = fn.toString();
  let output = "";
  let index = 0;
  let space = false;
  let regexAllowed = true;
  let braceDepth = 0;

  const flushSpace = (next: string) => {
    if (space && output.length > 0 && !/[\s([{.,;]$/u.test(output) && !/[)\]},.;]/u.test(next))
      output += " ";
    space = false;
  };

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1] ?? "";
    if (/\s/u.test(char)) {
      space = true;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      flushSpace(char);
      const quote = char;
      output += char;
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        output += current;
        index += 1;
        if (current === "\\" && index < source.length) {
          output += source[index]!;
          index += 1;
        } else if (current === quote) {
          break;
        }
      }
      regexAllowed = false;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      space = true;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
        index += 1;
      index = Math.min(index + 2, source.length);
      space = true;
      continue;
    }
    if (char === "/" && regexAllowed) {
      flushSpace(char);
      output += char;
      index += 1;
      let inCharacterClass = false;
      while (index < source.length) {
        const current = source[index]!;
        output += current;
        index += 1;
        if (current === "\\" && index < source.length) {
          output += source[index]!;
          index += 1;
        } else if (current === "[") {
          inCharacterClass = true;
        } else if (current === "]") {
          inCharacterClass = false;
        } else if (current === "/" && !inCharacterClass) {
          while (/[a-z]/iu.test(source[index] ?? "")) {
            output += source[index]!;
            index += 1;
          }
          break;
        }
      }
      regexAllowed = false;
      continue;
    }

    if (/[A-Za-z_$]/u.test(char)) {
      flushSpace(char);
      const start = index;
      while (/[\w$]/u.test(source[index] ?? "")) index += 1;
      const word = source.slice(start, index);
      output += word;
      regexAllowed = REGEX_PREFIX_KEYWORDS.has(word);
      continue;
    }

    if (/[0-9]/u.test(char)) {
      flushSpace(char);
      while (/[\w.]/u.test(source[index] ?? "")) {
        output += source[index]!;
        index += 1;
      }
      regexAllowed = false;
      continue;
    }

    if (char === ",") {
      index += 1;
      const following = source[nextNonWhitespace(source, index)];
      if (following === ")" || following === "]" || following === "}") continue;
      flushSpace(char);
      output += `,\n${"  ".repeat(braceDepth)}`;
      regexAllowed = true;
      continue;
    }

    if (char === ";") {
      flushSpace(char);
      output += `;\n${"  ".repeat(braceDepth)}`;
      index += 1;
      regexAllowed = true;
      continue;
    }

    if (char === "{") {
      output = output.replace(/[ \t]+$/u, "");
      if (output.length > 0 && !output.endsWith("\n")) output += " ";
      braceDepth += 1;
      output += `{\n${"  ".repeat(braceDepth)}`;
      index += 1;
      regexAllowed = true;
      continue;
    }

    if (char === "}") {
      output = output.replace(/[ \t]+$/u, "");
      braceDepth = Math.max(0, braceDepth - 1);
      output += `\n${"  ".repeat(braceDepth)}}`;
      index += 1;
      const afterBrace = nextNonWhitespace(source, index);
      if (source[afterBrace] === ";") index = afterBrace + 1;
      output += `\n${"  ".repeat(braceDepth)}`;
      regexAllowed = false;
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator !== undefined) {
      output = output.replace(/[ \t]+$/u, "");
      output += ` ${operator} `;
      index += operator.length;
      regexAllowed = true;
      continue;
    }

    if (char === ":") {
      output = output.replace(/[ \t]+$/u, "");
      output += ": ";
      index += 1;
      regexAllowed = true;
      continue;
    }

    flushSpace(char);
    output += char;
    index += 1;
    regexAllowed = "([!?".includes(char);
  }

  return output.trim();
};

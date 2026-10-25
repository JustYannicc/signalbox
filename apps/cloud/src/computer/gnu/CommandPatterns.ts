/** Helpers for the narrow command pattern and sed-script subset. */

export function simpleSedScript(script: string, extended: boolean): boolean {
  if (script.length === 0) return false;
  if (isDigit(script[0])) return simpleSedPrintAddress(script);

  if (!script.startsWith("s/")) return false;
  const patternEnd = script.indexOf("/", 2);
  if (patternEnd < 0) return false;
  const replacementEnd = script.indexOf("/", patternEnd + 1);
  if (replacementEnd < 0) return false;
  const pattern = script.slice(2, patternEnd);
  const replacement = script.slice(patternEnd + 1, replacementEnd);
  const flags = script.slice(replacementEnd + 1);
  if (flags !== "" && flags !== "g") return false;

  const captures = extended ? simpleExtendedPattern(pattern) : undefined;
  const safePattern = extended ? captures !== undefined : simpleBasicPattern(pattern);
  return safePattern && simpleReplacement(replacement, captures ?? 0);
}

function simpleSedPrintAddress(script: string): boolean {
  let cursor = 0;
  while (isDigit(script[cursor])) cursor++;
  const start = qualifiedAddress(script.slice(0, cursor));
  if (start === undefined) return false;

  if (script[cursor] === ",") {
    cursor++;
    const endStart = cursor;
    while (isDigit(script[cursor])) cursor++;
    const end = qualifiedAddress(script.slice(endStart, cursor));
    // The qualified subset has no GNU/applet proof for zero or descending addresses.
    if (end === undefined || end < start) return false;
  }

  return script.slice(cursor) === "p";
}

function qualifiedAddress(value: string): number | undefined {
  const address = Number(value);
  return Number.isSafeInteger(address) && address > 0 ? address : undefined;
}

/** Accepts literals and single-level capturing groups with literal alternatives only. */
export function simpleExtendedPattern(pattern: string): number | undefined {
  let start = pattern.startsWith("^") ? 1 : 0;
  let end = pattern.endsWith("$") ? pattern.length - 1 : pattern.length;
  if (start >= end) return undefined;

  let captures = 0;
  let cursor = start;
  const sequence = (inGroup: boolean): boolean => {
    let hasAtom = false;
    while (cursor < end && pattern[cursor] !== ")" && pattern[cursor] !== "|") {
      const character = pattern[cursor]!;
      if (character === "(") {
        if (inGroup) return false;
        captures++;
        cursor++;
        if (!alternatives(true) || pattern[cursor] !== ")") return false;
        cursor++;
      } else if (simplePatternCharacter(character)) {
        cursor++;
      } else {
        return false;
      }
      hasAtom = true;
    }
    return hasAtom;
  };
  const alternatives = (inGroup: boolean): boolean => {
    if (!sequence(inGroup)) return false;
    while (cursor < end && pattern[cursor] === "|") {
      if (!inGroup) return false;
      cursor++;
      if (!sequence(inGroup)) return false;
    }
    return true;
  };

  return alternatives(false) && cursor === end ? captures : undefined;
}

function simpleReplacement(value: string, captures: number): boolean {
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\") {
      const reference = value[index + 1];
      if (reference === undefined || reference < "1" || reference > "9") return false;
      if (Number(reference) > captures) return false;
      index++;
    } else if (!simplePatternCharacter(character)) {
      return false;
    }
  }
  return true;
}

export function simpleBasicPattern(value: string): boolean {
  return value.length > 0 && [...value].every(simplePatternCharacter);
}

function simplePatternCharacter(value: string): boolean {
  return (
    (value >= "a" && value <= "z") ||
    (value >= "A" && value <= "Z") ||
    (value >= "0" && value <= "9") ||
    value === "_" ||
    value === "-" ||
    value === " "
  );
}

export function isPrintableAscii(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

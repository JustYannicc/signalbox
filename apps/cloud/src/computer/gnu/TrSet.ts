const classes = new Set([
  "alpha",
  "alnum",
  "digit",
  "lower",
  "upper",
  "space",
  "blank",
  "punct",
  "cntrl",
  "xdigit",
]);
const escapes: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
};

type Token = { readonly end: number; readonly value?: number; readonly className?: string };

/** BusyBox's byte sets omit GNU repetition, equivalence, graph and print constructs. */
export function inspectTrSet(set: string) {
  let cursor = 0;
  const classNames: string[] = [];
  let bytes = 0;
  if (set.length > 4096) return undefined;
  while (cursor < set.length) {
    const first = token(set, cursor);
    if (first === undefined) return undefined;
    if (first.className !== undefined) classNames.push(first.className);
    cursor = first.end;
    bytes++;
    if (set[cursor] === "-" && cursor + 1 < set.length) {
      const last = token(set, cursor + 1);
      if (
        last === undefined ||
        first.value === undefined ||
        last.value === undefined ||
        first.value > last.value
      )
        return undefined;
      bytes += last.value - first.value;
      cursor = last.end;
    }
  }
  return { classNames, singleByte: bytes === 1 && classNames.length === 0 };
}

function token(set: string, index: number): Token | undefined {
  const value = set[index]!;
  if (value === "[") {
    if (set[index + 1] === ":") {
      const end = set.indexOf(":]", index + 2);
      const name = set.slice(index + 2, end);
      return end >= 0 && classes.has(name) ? { end: end + 2, className: name } : undefined;
    }
    if (set[index + 1] === "=" || /^\[[^\]]*\*/.test(set.slice(index))) return undefined;
  }
  if (value === "\\") {
    const next = set[index + 1];
    if (next === undefined) return undefined;
    if (Object.hasOwn(escapes, next)) return { end: index + 2, value: escapes[next]! };
    const octal = /^[0-7]{1,3}/.exec(set.slice(index + 1))?.[0];
    if (octal === undefined) return undefined;
    const byte = Number.parseInt(octal, 8);
    // BusyBox decodes escapes before recognizing set constructs; GNU parses them first.
    if ("[:=*]".includes(String.fromCharCode(byte))) return undefined;
    return byte <= 255 ? { end: index + 1 + octal.length, value: byte } : undefined;
  }
  const code = value.charCodeAt(0);
  return code > 0 && code < 128 ? { end: index + 1, value: code } : undefined;
}

export type IntegerSetting =
  | { readonly found: false }
  | { readonly found: true; readonly value: number | undefined };

type TomlToken = { readonly value: string; readonly kind: "bare" | "string" | "punct" | "newline" };

function tokenizeToml(source: string): TomlToken[] {
  const tokens: TomlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") {
      tokens.push({ value: "\n", kind: "newline" });
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "#") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const multiline = source.startsWith(quote.repeat(3), index);
      const openingLength = multiline ? 3 : 1;
      const close = quote.repeat(openingLength);
      const start = index + openingLength;
      let end = start;
      while (end < source.length) {
        if (quote === '"' && source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source.startsWith(close, end)) break;
        end += 1;
      }
      const raw = source.slice(start, end);
      let value = raw;
      if (quote === '"') {
        try {
          value = JSON.parse(`"${raw.replaceAll('"', '\\"')}"`) as string;
        } catch {
          /* The caller fails closed if a malformed quoted key or value matters. */
        }
      }
      tokens.push({ value, kind: "string" });
      index = end < source.length ? end + openingLength : source.length;
      continue;
    }
    if (["[", "]", "{", "}", "=", ".", ","].includes(char)) {
      tokens.push({ value: char, kind: "punct" });
      index += 1;
      continue;
    }
    const start = index;
    while (index < source.length && !/[\s[\]{}=.,#"']/u.test(source[index]!)) index += 1;
    if (index === start) {
      tokens.push({ value: char, kind: "punct" });
      index += 1;
    } else tokens.push({ value: source.slice(start, index), kind: "bare" });
  }
  return tokens;
}

function dottedTomlKey(tokens: readonly TomlToken[]): string[] | undefined {
  const result: string[] = [];
  let expectKey = true;
  for (const token of tokens) {
    if (expectKey) {
      if (token.kind !== "bare" && token.kind !== "string") return undefined;
      if (token.value.length === 0) return undefined;
      result.push(token.value);
      expectKey = false;
    } else {
      if (token.value !== ".") return undefined;
      expectKey = true;
    }
  }
  return result.length && !expectKey ? result : undefined;
}

function splitTomlEntries(tokens: readonly TomlToken[]): TomlToken[][] {
  const entries: TomlToken[][] = [];
  let current: TomlToken[] = [];
  let braces = 0;
  let brackets = 0;
  for (const token of tokens) {
    if (token.value === "{") braces += 1;
    else if (token.value === "}") braces -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    if (token.value === "," && braces === 0 && brackets === 0) {
      if (current.length) entries.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) entries.push(current);
  return entries;
}

function integerTomlValue(tokens: readonly TomlToken[]): number | undefined {
  if (tokens.length !== 1 || tokens[0]!.kind !== "bare") return undefined;
  const integer = /^[+-]?\d[\d_]*$/u.exec(tokens[0]!.value);
  if (!integer) return undefined;
  const value = Number(integer[0].replaceAll("_", ""));
  return Number.isSafeInteger(value) ? value : undefined;
}

export function integerSettingFromToml(source: string, key: string): IntegerSetting {
  const target = key.split(".");
  const values: Array<number | undefined> = [];
  const tokens = tokenizeToml(source);
  const statements: TomlToken[][] = [];
  let statement: TomlToken[] = [];
  let braces = 0;
  let brackets = 0;
  for (const token of tokens) {
    if (token.kind === "newline" && braces === 0 && brackets === 0) {
      if (statement.length) statements.push(statement);
      statement = [];
      continue;
    }
    statement.push(token);
    if (token.value === "{") braces += 1;
    else if (token.value === "}") braces -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
  }
  if (statement.length) statements.push(statement);

  let section: string[] = [];
  const record = (path: readonly string[], value: readonly TomlToken[]) => {
    if (path.length === target.length && path.every((part, index) => part === target[index])) {
      values.push(integerTomlValue(value));
      return;
    }
    if (target.length <= path.length || !path.every((part, index) => part === target[index]))
      return;
    if (value[0]?.value !== "{" || value.at(-1)?.value !== "}") return;
    const content = value.slice(1, -1).filter((token) => token.kind !== "newline");
    for (const entry of splitTomlEntries(content)) {
      const equals = entry.findIndex((token) => token.value === "=");
      if (equals < 0) continue;
      const nestedKey = dottedTomlKey(entry.slice(0, equals));
      if (nestedKey)
        record(
          [...path, ...nestedKey],
          entry.slice(equals + 1).filter((token) => token.kind !== "newline"),
        );
    }
  };

  for (const current of statements) {
    if (current[0]?.value === "[") {
      const arrayTable = current[1]?.value === "[";
      const start = arrayTable ? 2 : 1;
      const end = current.length - (arrayTable ? 2 : 1);
      const path = dottedTomlKey(current.slice(start, end));
      if (!path) {
        section = [];
        continue;
      }
      section = path;
      if (
        section.length === target.length &&
        section.every((part, index) => part === target[index])
      )
        values.push(undefined);
      continue;
    }
    const equals = current.findIndex((token) => token.value === "=");
    if (equals < 0) continue;
    const localKey = dottedTomlKey(current.slice(0, equals));
    if (localKey) record([...section, ...localKey], current.slice(equals + 1));
  }
  if (!values.length) return { found: false };
  if (values.length !== 1 || values[0] === undefined) return { found: true, value: undefined };
  return { found: true, value: values[0] };
}

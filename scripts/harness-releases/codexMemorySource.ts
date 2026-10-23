import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type Token = {
  readonly value: string;
  readonly kind: "word" | "number" | "string" | "punct";
  readonly line: number;
};

export type RustField = {
  readonly tokens: ReadonlyArray<Token>;
  readonly attributes: ReadonlyArray<ReadonlyArray<Token>>;
};

export function tokenizeRust(source: string): Token[] {
  const result: Token[] = [];
  let index = 0;
  let line = 1;
  const advance = (end: number) => {
    line += source.slice(index, end).match(/\n/gu)?.length ?? 0;
    index = end;
  };

  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) {
      advance(index + 1);
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      advance(end < 0 ? source.length : end);
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let end = index + 2;
      while (end < source.length && depth > 0) {
        if (source.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else end += 1;
      }
      advance(end);
      continue;
    }

    const rawString = /^(?:br|r)(#+)?"/u.exec(source.slice(index));
    if (rawString) {
      const hashes = rawString[1] ?? "";
      const contentStart = index + rawString[0].length;
      const endMarker = `"${hashes}`;
      const close = source.indexOf(endMarker, contentStart);
      const end = close < 0 ? source.length : close + endMarker.length;
      result.push({
        kind: "string",
        value: source.slice(contentStart, close < 0 ? source.length : close),
        line,
      });
      advance(end);
      continue;
    }
    if (char === '"' || (char === "b" && source[index + 1] === '"')) {
      const quote = char === "b" ? index + 1 : index;
      let end = quote + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === '"') break;
      }
      result.push({
        kind: "string",
        value: source.slice(quote + 1, Math.max(quote + 1, end - 1)),
        line,
      });
      advance(end);
      continue;
    }

    const word = /^(?:r#)?[A-Za-z_][A-Za-z_0-9]*/u.exec(source.slice(index));
    if (word) {
      result.push({ kind: "word", value: word[0].replace(/^r#/u, ""), line });
      advance(index + word[0].length);
      continue;
    }
    const number = /^\d[\d_]*/u.exec(source.slice(index));
    if (number) {
      result.push({ kind: "number", value: number[0].replaceAll("_", ""), line });
      advance(index + number[0].length);
      continue;
    }
    result.push({ kind: "punct", value: char, line });
    advance(index + 1);
  }
  return result;
}

export function hasSequence(tokens: readonly Token[], values: readonly string[]): boolean {
  for (let start = 0; start <= tokens.length - values.length; start += 1) {
    if (values.every((value, offset) => tokens[start + offset]!.value === value)) return true;
  }
  return false;
}

function matchingClose(
  tokens: readonly Token[],
  openIndex: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]!.value === open) depth += 1;
    else if (tokens[index]!.value === close && --depth === 0) return index;
  }
  return undefined;
}

function attributesBefore(
  tokens: readonly Token[],
  targetIndex: number,
): ReadonlyArray<ReadonlyArray<Token>> {
  const attributes: Token[][] = [];
  let cursor = targetIndex - 1;
  while (cursor >= 0 && tokens[cursor]!.value === "]") {
    let depth = 1;
    let openIndex = cursor - 1;
    for (; openIndex >= 0 && depth > 0; openIndex -= 1) {
      if (tokens[openIndex]!.value === "]") depth += 1;
      else if (tokens[openIndex]!.value === "[") depth -= 1;
    }
    openIndex += 1;
    if (tokens[openIndex]?.value !== "[") break;
    const start = tokens[openIndex - 1]?.value === "#" ? openIndex - 1 : openIndex;
    attributes.unshift(tokens.slice(start, cursor + 1));
    cursor = start - 1;
  }
  return attributes;
}

function structIndex(tokens: readonly Token[], name: string): number | undefined {
  const matches = tokens.flatMap((token, index) =>
    token.kind === "word" &&
    token.value === "struct" &&
    tokens[index + 1]?.kind === "word" &&
    tokens[index + 1]?.value === name
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function structField(
  tokens: readonly Token[],
  structName: string,
  fieldName: string,
): RustField | undefined {
  const declaration = structIndex(tokens, structName);
  if (declaration === undefined || declaration < 0) return undefined;
  let openIndex = declaration + 2;
  while (openIndex < tokens.length && tokens[openIndex]!.value !== "{") openIndex += 1;
  const closeIndex = matchingClose(tokens, openIndex, "{", "}");
  if (closeIndex === undefined) return undefined;

  let depth = 1;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const value = tokens[index]!.value;
    if (
      depth === 1 &&
      value === "pub" &&
      tokens[index + 1]?.value === fieldName &&
      tokens[index + 2]?.value === ":"
    ) {
      let end = index + 3;
      let nested = 0;
      for (; end < closeIndex; end += 1) {
        const token = tokens[end]!.value;
        if (["(", "[", "{"].includes(token)) nested += 1;
        else if ([")", "]", "}"].includes(token)) nested -= 1;
        else if (token === "," && nested === 0) break;
      }
      return { tokens: tokens.slice(index + 3, end), attributes: attributesBefore(tokens, index) };
    }
    if (value === "{") depth += 1;
    else if (value === "}") depth -= 1;
  }
  return undefined;
}

export function hasDerived(tokens: readonly Token[], structName: string, trait: string): boolean {
  const declaration = structIndex(tokens, structName);
  if (declaration === undefined || declaration < 0) return false;
  const target = tokens[declaration - 1]?.value === "pub" ? declaration - 1 : declaration;
  return attributesBefore(tokens, target).some(
    (attribute) =>
      attribute[1]?.value === "[" &&
      attribute[2]?.value === "derive" &&
      attribute.some((token) => token.value === trait),
  );
}

function serdeNameIsCanonical(attributes: ReadonlyArray<ReadonlyArray<Token>>): boolean {
  return attributes.every((attribute) => {
    const serde = attribute.findIndex(
      (token, index) => token.value === "serde" && attribute[index + 1]?.value === "(",
    );
    if (serde < 0) return true;
    const close = matchingClose(attribute, serde + 1, "(", ")");
    if (close === undefined) return false;
    return !attribute
      .slice(serde + 2, close)
      .some((token) =>
        [
          "rename",
          "rename_all",
          "alias",
          "alias_all",
          "skip",
          "skip_deserializing",
          "flatten",
        ].includes(token.value),
      );
  });
}

function hasSerdeAttributes(attributes: ReadonlyArray<ReadonlyArray<Token>>): boolean {
  return attributes.some((attribute) =>
    attribute.some(
      (token, index) =>
        token.kind === "word" && token.value === "serde" && attribute[index + 1]?.value === "(",
    ),
  );
}

export function hasCanonicalSerdeNameOnStruct(
  tokens: readonly Token[],
  structName: string,
): boolean {
  const declaration = structIndex(tokens, structName);
  if (declaration === undefined || declaration < 0) return false;
  const target = tokens[declaration - 1]?.value === "pub" ? declaration - 1 : declaration;
  return serdeNameIsCanonical(attributesBefore(tokens, target));
}

export function hasCanonicalSerdeName(field: RustField): boolean {
  return serdeNameIsCanonical(field.attributes);
}

export function hasNoSerdeAttributes(field: RustField): boolean {
  return !hasSerdeAttributes(field.attributes);
}

export function hasNoSerdeAttributesOnStruct(
  tokens: readonly Token[],
  structName: string,
): boolean {
  const declaration = structIndex(tokens, structName);
  if (declaration === undefined) return false;
  const target = tokens[declaration - 1]?.value === "pub" ? declaration - 1 : declaration;
  return !hasSerdeAttributes(attributesBefore(tokens, target));
}

export function hasSerdeDefault(field: RustField, functionName: string): boolean {
  return field.attributes.some((attribute) =>
    hasSequence(attribute, ["serde", "(", "default", "=", functionName]),
  );
}

export function isOptionalNumber(tokens: readonly Token[]): boolean {
  return (
    tokens[0]?.value === "Option" &&
    tokens[1]?.value === "<" &&
    ["usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"].includes(
      tokens[2]?.value ?? "",
    ) &&
    tokens[3]?.value === ">"
  );
}

export function isNumber(tokens: readonly Token[]): boolean {
  return (
    tokens.length === 1 &&
    ["usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"].includes(
      tokens[0]!.value,
    )
  );
}

export function functionBody(
  tokens: readonly Token[],
  name: string,
): ReadonlyArray<Token> | undefined {
  const matches = tokens.flatMap((token, index) =>
    token.kind === "word" &&
    token.value === "fn" &&
    tokens[index + 1]?.kind === "word" &&
    tokens[index + 1]?.value === name
      ? [index]
      : [],
  );
  if (matches.length !== 1) return undefined;
  const index = matches[0]!;
  let open = index + 2;
  while (open < tokens.length && tokens[open]!.value !== "{") open += 1;
  const close = matchingClose(tokens, open, "{", "}");
  return close === undefined ? undefined : tokens.slice(open + 1, close);
}

function integerExpression(
  tokens: readonly Token[],
  resolve: (name: string) => number | undefined,
): number | undefined {
  let index = 0;
  const parsePrimary = (): number | undefined => {
    const token = tokens[index];
    if (!token) return undefined;
    if (token.value === "+" || token.value === "-") {
      index += 1;
      const value = parsePrimary();
      const result = token.value === "-" && value !== undefined ? -value : value;
      return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
    }
    if (token.value === "(") {
      index += 1;
      const value = parseSum();
      if (tokens[index]?.value !== ")") return undefined;
      index += 1;
      return value;
    }
    if (token.kind === "number") {
      index += 1;
      const value = Number(token.value);
      return Number.isSafeInteger(value) ? value : undefined;
    }
    if (token.kind === "word") {
      index += 1;
      return resolve(token.value);
    }
    return undefined;
  };
  const parseProduct = (): number | undefined => {
    let value = parsePrimary();
    while (value !== undefined && ["*", "/"].includes(tokens[index]?.value ?? "")) {
      const operator = tokens[index++]!.value;
      const right = parsePrimary();
      if (right === undefined || (operator === "/" && (right === 0 || value % right !== 0)))
        return undefined;
      value = operator === "*" ? value * right : value / right;
      if (!Number.isSafeInteger(value)) return undefined;
    }
    return value;
  };
  function parseSum(): number | undefined {
    let value = parseProduct();
    while (value !== undefined && ["+", "-"].includes(tokens[index]?.value ?? "")) {
      const operator = tokens[index++]!.value;
      const right = parseProduct();
      if (right === undefined) return undefined;
      value = operator === "+" ? value + right : value - right;
      if (!Number.isSafeInteger(value)) return undefined;
    }
    return value;
  }
  const value = parseSum();
  return index === tokens.length ? value : undefined;
}

function constantValueWithStack(
  tokens: readonly Token[],
  name: string,
  stack: ReadonlySet<string>,
): number | undefined {
  if (stack.has(name)) return undefined;
  const declarations = tokens.flatMap((token, index) =>
    token.kind === "word" &&
    token.value === "const" &&
    tokens[index + 1]?.kind === "word" &&
    tokens[index + 1]?.value === name
      ? [index]
      : [],
  );
  if (declarations.length !== 1) return undefined;
  const equal = tokens.findIndex((token, index) => index > declarations[0]! && token.value === "=");
  if (equal < 0) return undefined;
  const end = tokens.findIndex((token, index) => index > equal && token.value === ";");
  if (end < 0) return undefined;
  const nextStack = new Set(stack);
  nextStack.add(name);
  return integerExpression(tokens.slice(equal + 1, end), (identifier) =>
    constantValueWithStack(tokens, identifier, nextStack),
  );
}

export function constantValue(tokens: readonly Token[], name: string): number | undefined {
  return constantValueWithStack(tokens, name, new Set());
}

function implementationBody(
  tokens: readonly Token[],
  marker: readonly string[],
): ReadonlyArray<Token> | undefined {
  const starts = tokens.flatMap((_, index) =>
    hasSequence(tokens.slice(index, index + marker.length), marker) ? [index] : [],
  );
  if (starts.length !== 1) return undefined;
  let open = starts[0]! + marker.length;
  while (open < tokens.length && tokens[open]!.value !== "{") open += 1;
  const close = matchingClose(tokens, open, "{", "}");
  return close === undefined ? undefined : tokens.slice(open + 1, close);
}

function fieldInitializer(
  tokens: readonly Token[],
  field: string,
): ReadonlyArray<Token> | undefined {
  const matches = tokens.flatMap((token, index) =>
    token.kind === "word" && token.value === field && tokens[index + 1]?.value === ":"
      ? [index]
      : [],
  );
  if (matches.length !== 1) return undefined;

  const expression: Token[] = [];
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = matches[0]! + 2; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === "(") parens += 1;
    else if (token.value === ")") parens -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    else if (token.value === "{") braces += 1;
    else if (token.value === "}") {
      if (braces === 0 && parens === 0 && brackets === 0) break;
      braces -= 1;
    }
    if (token.value === "," && parens === 0 && brackets === 0 && braces === 0) break;
    expression.push(token);
  }
  return expression.length ? expression : undefined;
}

export function assignedDefault(
  tokens: readonly Token[],
  implementation: "Default" | "From",
  field: string,
  constant: string,
): boolean {
  const marker =
    implementation === "Default"
      ? ["impl", "Default", "for", "MemoriesConfig"]
      : ["impl", "From", "<", "MemoriesToml", ">", "for", "MemoriesConfig"];
  const body = implementationBody(tokens, marker);
  const expression = body && fieldInitializer(body, field);
  if (!expression) return false;
  if (implementation === "Default") {
    return (
      expression.length === 1 && expression[0]!.kind === "word" && expression[0]!.value === constant
    );
  }
  return hasSequence(expression, [
    "toml",
    ".",
    field,
    ".",
    "unwrap_or",
    "(",
    "defaults",
    ".",
    field,
    ")",
  ]);
}

export function clampedDefault(
  tokens: readonly Token[],
  field: string,
  constant: string,
): number | undefined {
  const sequence = ["toml", ".", field, ".", "unwrap_or", "(", "defaults", ".", field, ")"];
  const body = implementationBody(tokens, [
    "impl",
    "From",
    "<",
    "MemoriesToml",
    ">",
    "for",
    "MemoriesConfig",
  ]);
  const expression = body && fieldInitializer(body, field);
  if (!expression || !hasSequence(expression.slice(0, sequence.length), sequence)) return undefined;
  const nativeDefault = constantValue(tokens, constant);
  if (nativeDefault === undefined) return undefined;
  const afterFallback = sequence.length;
  if (expression.length === afterFallback) return nativeDefault;
  if (
    expression[afterFallback]?.value !== "." ||
    expression[afterFallback + 1]?.value !== "clamp" ||
    expression[afterFallback + 2]?.value !== "("
  )
    return undefined;
  const close = matchingClose(expression, afterFallback + 2, "(", ")");
  if (close !== expression.length - 1) return undefined;
  if (close === undefined) return undefined;
  const comma = expression.findIndex(
    (token, index) => index > afterFallback + 2 && index < close && token.value === ",",
  );
  if (comma < 0) return undefined;
  const resolve = (name: string) => constantValue(tokens, name);
  const minimum = integerExpression(expression.slice(afterFallback + 3, comma), resolve);
  const maximumTokens = expression.slice(comma + 1, close);
  if (maximumTokens.at(-1)?.value === ",") maximumTokens.pop();
  const maximum = integerExpression(maximumTokens, resolve);
  return minimum === undefined || maximum === undefined
    ? undefined
    : Math.max(minimum, Math.min(maximum, nativeDefault));
}

export async function listRustFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await listRustFiles(path)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".rs") &&
      !/(?:^|_)(?:test|tests)\.rs$/u.test(entry.name) &&
      !path.split(NodePath.sep).includes("tests")
    )
      found.push(path);
  }
  return found;
}

export function withoutTestOnlyItems(tokens: readonly Token[]): Token[] {
  const visible = Array.from({ length: tokens.length }, () => true);
  for (let index = 0; index < tokens.length - 6; index += 1) {
    if (!hasSequence(tokens.slice(index, index + 7), ["#", "[", "cfg", "(", "test", ")", "]"]))
      continue;
    const next = index + 7;
    let open = next;
    while (open < tokens.length && tokens[open]!.value !== "{" && tokens[open]!.value !== ";")
      open += 1;
    const end = tokens[open]?.value === "{" ? matchingClose(tokens, open, "{", "}") : open;
    if (end === undefined) continue;
    for (let hidden = index; hidden <= end; hidden += 1) visible[hidden] = false;
    index = end;
  }
  return tokens.filter((_, index) => visible[index]);
}

function parameterType(parameters: readonly Token[], variable: string): string | undefined {
  const parts: Token[][] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= parameters.length; index += 1) {
    const value = parameters[index]?.value;
    if (["<", "(", "[", "{"].includes(value ?? "")) depth += 1;
    else if ([">", ")", "]", "}"].includes(value ?? "")) depth -= 1;
    if (index === parameters.length || (value === "," && depth === 0)) {
      if (index > start) parts.push(parameters.slice(start, index));
      start = index + 1;
    }
  }
  const parameter = parts.find((part) => part[0]?.value === variable && part[1]?.value === ":");
  if (!parameter) return undefined;
  const type = parameter.slice(2);
  let pointee = type.map((token) => token.value);
  if (pointee[0] === "&") pointee = pointee.slice(1);
  if (pointee[0] === "'") pointee = pointee.slice(2);
  if (pointee[0] === "mut") pointee = pointee.slice(1);
  if (pointee.length === 1 && type.at(-1)?.kind === "word") return pointee[0];
  if (
    pointee.length === 4 &&
    pointee[0] === "Arc" &&
    pointee[1] === "<" &&
    pointee[3] === ">" &&
    type.at(-2)?.kind === "word"
  )
    return pointee[2];
  return undefined;
}

function functionScopes(
  tokens: readonly Token[],
): Array<{ readonly body: readonly Token[]; readonly parameters: readonly Token[] }> {
  const scopes: Array<{ readonly body: readonly Token[]; readonly parameters: readonly Token[] }> =
    [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      tokens[index]!.kind !== "word" ||
      tokens[index]!.value !== "fn" ||
      tokens[index + 1]?.kind !== "word"
    )
      continue;
    let parametersOpen = index + 2;
    while (parametersOpen < tokens.length && tokens[parametersOpen]!.value !== "(")
      parametersOpen += 1;
    const parametersClose = matchingClose(tokens, parametersOpen, "(", ")");
    if (parametersClose === undefined) continue;
    let bodyOpen = parametersClose + 1;
    let angleDepth = 0;
    for (; bodyOpen < tokens.length; bodyOpen += 1) {
      if (tokens[bodyOpen]!.value === "<") angleDepth += 1;
      else if (tokens[bodyOpen]!.value === ">" && tokens[bodyOpen - 1]?.value !== "-")
        angleDepth -= 1;
      else if (tokens[bodyOpen]!.value === "{" && angleDepth === 0) break;
      else if (tokens[bodyOpen]!.value === ";" && angleDepth === 0) break;
    }
    if (tokens[bodyOpen]?.value !== "{") continue;
    const bodyClose = matchingClose(tokens, bodyOpen, "{", "}");
    if (bodyClose === undefined) continue;
    scopes.push({
      body: tokens.slice(bodyOpen + 1, bodyClose),
      parameters: tokens.slice(parametersOpen + 1, parametersClose),
    });
    index = bodyOpen;
  }
  return scopes;
}

export function hasFunctionBodySequences(
  tokens: readonly Token[],
  sequences: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return functionScopes(tokens).some(({ body }) =>
    sequences.every((sequence) => hasSequence(body, sequence)),
  );
}

function hasLocalBinding(tokens: readonly Token[], variable: string): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === "let") {
      for (
        let pattern = index + 1;
        pattern < tokens.length && !["=", ";"].includes(tokens[pattern]!.value);
        pattern += 1
      ) {
        if (tokens[pattern]!.value === variable) return true;
      }
    }
    if (
      token.value === "for" &&
      (tokens[index + 1]?.value === variable ||
        (tokens[index + 1]?.value === "mut" && tokens[index + 2]?.value === variable))
    )
      return true;
    if (
      token.value === "|" &&
      (tokens[index + 1]?.value === variable ||
        (tokens[index + 1]?.value === "mut" && tokens[index + 2]?.value === variable)) &&
      tokens.slice(index + 1, index + 5).some((candidate) => candidate.value === "|")
    )
      return true;
    if (token.value === "fn") {
      let parametersOpen = index + 2;
      while (parametersOpen < tokens.length && tokens[parametersOpen]!.value !== "(")
        parametersOpen += 1;
      const parametersClose = matchingClose(tokens, parametersOpen, "(", ")");
      if (
        parametersClose !== undefined &&
        tokens
          .slice(parametersOpen + 1, parametersClose)
          .some(
            (parameter, offset, parameters) =>
              parameter.kind === "word" &&
              parameter.value === variable &&
              parameters[offset + 1]?.value === ":",
          )
      )
        return true;
    }
  }
  return false;
}

export function memberReadLines(
  tokens: readonly Token[],
  field: string,
  owners: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly type: string }>,
): number[] {
  const lines: number[] = [];
  for (const { body, parameters } of functionScopes(tokens)) {
    for (const owner of owners) {
      const variable = owner.path[0]!;
      if (parameterType(parameters, variable) !== owner.type || hasLocalBinding(body, variable))
        continue;
      const access = [...owner.path, field];
      for (let index = 0; index <= body.length - access.length; index += 1) {
        const expression = body.slice(index, index + access.length);
        if (!access.every((part, offset) => expression[offset]!.value === part)) continue;
        const next = body[index + access.length];
        if (["="].includes(next?.value ?? "")) continue;
        lines.push(body[index + access.length - 1]!.line);
      }
    }
  }
  return lines;
}

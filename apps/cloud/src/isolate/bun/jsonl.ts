export type BunJsonlInput = string | ArrayBuffer | ArrayBufferView;

export interface BunJsonlParseChunkResult {
  values: unknown[];
  read: number;
  done: boolean;
  error: SyntaxError | null;
}

type ValueScan =
  | { status: "value"; end: number }
  | { status: "incomplete"; end?: number }
  | { status: "invalid" };

type ContainerFrame =
  | { kind: "object"; state: "keyOrEnd" | "key" | "colon" | "value" | "separator" }
  | { kind: "array"; state: "valueOrEnd" | "value" | "separator" };

interface InputWindow {
  text: string;
  readAt(characterOffset: number): number;
  initialRead: number;
}

const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function clampOffset(value: number | undefined, fallback: number, length: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(Math.trunc(value), length);
}

function inputWindow(input: BunJsonlInput, start?: number, end?: number): InputWindow {
  if (typeof input === "string") {
    const first = clampOffset(start !== undefined && start > 0 ? start : 0, 0, input.length);
    const last = clampOffset(
      end !== undefined && end >= 0 ? end : input.length,
      input.length,
      input.length,
    );
    const from = Math.min(first, last);
    const text = input.slice(from, last);
    return {
      text,
      initialRead: from,
      readAt: (characterOffset) => from + characterOffset,
    };
  }

  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError("JSONL input must be a string, ArrayBuffer, or ArrayBufferView");
  }

  const first = clampOffset(start !== undefined && start > 0 ? start : 0, 0, bytes.length);
  const last = clampOffset(
    end !== undefined && end >= 0 ? end : bytes.length,
    bytes.length,
    bytes.length,
  );
  const from = Math.min(first, last);
  let content = bytes.subarray(from, last);
  let initialRead = from;
  if (
    from === 0 &&
    content.length >= 3 &&
    content[0] === 0xef &&
    content[1] === 0xbb &&
    content[2] === 0xbf
  ) {
    content = content.subarray(3);
    initialRead += 3;
  }
  const text = textDecoder.decode(content);
  let mappedCharacterOffset = 0;
  let mappedByteOffset = initialRead;
  return {
    text,
    initialRead,
    readAt(characterOffset) {
      while (mappedCharacterOffset < characterOffset) {
        const codePoint = text.codePointAt(mappedCharacterOffset)!;
        mappedByteOffset += utf8ByteLength(codePoint);
        mappedCharacterOffset += codePoint > 0xffff ? 2 : 1;
      }
      return mappedByteOffset;
    },
  };
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function skipWhitespace(text: string, from: number): { offset: number; lineFeed: boolean } {
  let offset = from;
  let lineFeed = false;
  while (offset < text.length && isWhitespace(text[offset]!)) {
    if (text[offset] === "\n") lineFeed = true;
    offset++;
  }
  return { offset, lineFeed };
}

function scanString(text: string, start: number): ValueScan {
  for (let offset = start + 1; offset < text.length; offset++) {
    const character = text[offset]!;
    if (character === '"') return { status: "value", end: offset + 1 };
    if (character.charCodeAt(0) < 0x20) return { status: "invalid" };
    if (character !== "\\") continue;

    offset++;
    if (offset >= text.length) return { status: "incomplete" };
    const escaped = text[offset]!;
    if (escaped === "u") {
      for (let digit = 1; digit <= 4; digit++) {
        if (offset + digit >= text.length) return { status: "incomplete" };
        if (!/[0-9a-f]/i.test(text[offset + digit]!)) return { status: "invalid" };
      }
      offset += 4;
    } else if (!'"\\/bfnrt'.includes(escaped)) {
      return { status: "invalid" };
    }
  }
  return { status: "incomplete" };
}

function scanContainer(text: string, start: number): ValueScan {
  const first = text[start]!;
  const frames: ContainerFrame[] = [
    first === "{" ? { kind: "object", state: "keyOrEnd" } : { kind: "array", state: "valueOrEnd" },
  ];
  let offset = start + 1;

  while (frames.length > 0) {
    offset = skipWhitespace(text, offset).offset;
    if (offset === text.length) return { status: "incomplete" };

    const character = text[offset]!;
    const frame = frames[frames.length - 1]!;
    if (frame.kind === "object") {
      if (
        (frame.state === "key" || frame.state === "value") &&
        character === "}" &&
        frames.length === 1
      ) {
        return { status: "incomplete", end: offset + 1 };
      }

      if (frame.state === "keyOrEnd" || frame.state === "key") {
        if (frame.state === "keyOrEnd" && character === "}") {
          offset++;
          frames.pop();
          if (frames.length === 0) return { status: "value", end: offset };
          continue;
        }
        if (character !== '"') return { status: "invalid" };
        const key = scanString(text, offset);
        if (key.status !== "value") return key;
        offset = key.end;
        frame.state = "colon";
        continue;
      }

      if (frame.state === "colon") {
        if (character !== ":") return { status: "invalid" };
        frame.state = "value";
        offset++;
        continue;
      }

      if (frame.state === "separator") {
        if (character === "}") {
          offset++;
          frames.pop();
          if (frames.length === 0) return { status: "value", end: offset };
          continue;
        }
        if (character !== ",") return { status: "invalid" };
        frame.state = "key";
        offset++;
        continue;
      }

      frame.state = "separator";
    } else {
      if (frame.state === "value" && character === "]" && frames.length === 1) {
        return { status: "incomplete", end: offset + 1 };
      }

      if (frame.state === "valueOrEnd" && character === "]") {
        offset++;
        frames.pop();
        if (frames.length === 0) return { status: "value", end: offset };
        continue;
      }

      if (frame.state === "separator") {
        if (character === "]") {
          offset++;
          frames.pop();
          if (frames.length === 0) return { status: "value", end: offset };
          continue;
        }
        if (character !== ",") return { status: "invalid" };
        frame.state = "value";
        offset++;
        continue;
      }

      frame.state = "separator";
    }

    if (character === "{" || character === "[") {
      frames.push(
        character === "{"
          ? { kind: "object", state: "keyOrEnd" }
          : { kind: "array", state: "valueOrEnd" },
      );
      offset++;
      continue;
    }

    const value = character === '"' ? scanString(text, offset) : scanPrimitive(text, offset, true);
    if (value.status !== "value") return value;
    offset = value.end;
  }

  return { status: "invalid" };
}

function isIncompletePrimitive(token: string): boolean {
  if (
    ["true", "false", "null"].some(
      (literal) => literal.startsWith(token) && token.length < literal.length,
    )
  )
    return true;
  if (token === "-") return true;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(token) && /[.eE+-]$/.test(token))
    return true;
  return token.length === 1 && !/[0-9]/.test(token);
}

function scanPrimitive(text: string, start: number, inContainer = false): ValueScan {
  let end = start;
  while (end < text.length && !isWhitespace(text[end]!)) {
    if (inContainer && ",]}".includes(text[end]!)) break;
    end++;
  }
  if (end === start) return { status: "invalid" };
  const token = text.slice(start, end);
  try {
    JSON.parse(token);
    return { status: "value", end };
  } catch {
    return isIncompletePrimitive(token) && end === text.length
      ? { status: "incomplete", end }
      : { status: "invalid" };
  }
}

function scanValue(text: string, start: number): ValueScan {
  const first = text[start]!;
  if (first === '"') return scanString(text, start);
  if (first === "{" || first === "[") return scanContainer(text, start);
  return scanPrimitive(text, start);
}

function syntaxError(): SyntaxError {
  return new SyntaxError("Failed to parse JSONL");
}

function parseChunk(input: BunJsonlInput, start?: number, end?: number): BunJsonlParseChunkResult {
  const { text, readAt, initialRead } = inputWindow(input, start, end);
  const values: unknown[] = [];
  let read = initialRead;
  let cursor = skipWhitespace(text, 0).offset;

  while (cursor < text.length) {
    const scanned = scanValue(text, cursor);
    if (scanned.status === "incomplete") {
      if (scanned.end !== undefined && scanned.end < text.length) {
        return { values, read, done: false, error: syntaxError() };
      }
      return { values, read, done: false, error: null };
    }
    if (scanned.status === "invalid") return { values, read, done: false, error: syntaxError() };

    const raw = text.slice(cursor, scanned.end);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { values, read, done: false, error: syntaxError() };
    }

    values.push(value);
    read = readAt(scanned.end);
    const next = skipWhitespace(text, scanned.end);
    if (next.offset === text.length) return { values, read, done: true, error: null };
    if (!next.lineFeed) return { values, read, done: false, error: syntaxError() };
    cursor = next.offset;
  }

  return { values, read, done: true, error: null };
}

function parse(input: BunJsonlInput): unknown[] {
  const result = parseChunk(input);
  if (result.error !== null && result.values.length === 0) throw result.error;
  return result.values;
}

export const bunJsonl = { parse, parseChunk };

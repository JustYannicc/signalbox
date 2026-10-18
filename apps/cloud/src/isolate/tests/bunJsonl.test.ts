import { describe, expect, it } from "@effect/vitest";

import { bunJsonl } from "../bun/jsonl.ts";

describe("Bun.JSONL compatibility", () => {
  it("parses pretty-printed values and newline-separated records", () => {
    expect(bunJsonl.parse('{\n  "a": 1\n}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reports string character offsets and byte offsets within selected windows", () => {
    const input = 'prefix\n{"é":"😀"}\n{"n":2}\nignore';
    const stringEnd = input.indexOf("\nignore") + 1;
    const stringResult = bunJsonl.parseChunk(input, 7, stringEnd);
    expect(stringResult).toEqual({
      values: [{ é: "😀" }, { n: 2 }],
      read: stringEnd - 1,
      done: true,
      error: null,
    });

    const encoded = new TextEncoder().encode(input);
    const padded = new Uint8Array(encoded.length + 2);
    padded[0] = 0xff;
    padded.set(encoded, 1);
    padded[padded.length - 1] = 0xfe;
    const view = padded.subarray(1, padded.length - 1);
    const byteEnd = new TextEncoder().encode(input.slice(0, stringEnd)).byteLength;

    for (const bytes of [view, new DataView(view.buffer, view.byteOffset, view.byteLength)]) {
      expect(bunJsonl.parseChunk(bytes, 7, byteEnd)).toEqual({
        values: [{ é: "😀" }, { n: 2 }],
        read: byteEnd - 1,
        done: true,
        error: null,
      });
    }

    const arrayBuffer = new TextEncoder().encode('{"a":1}\n').buffer;
    expect(bunJsonl.parse(arrayBuffer)).toEqual([{ a: 1 }]);
  });

  it("keeps valid values and the read offset before an incomplete trailing value", () => {
    const result = bunJsonl.parseChunk('{"a":1}\n{"b":');
    expect(result.values).toEqual([{ a: 1 }]);
    expect(result.read).toBe(7);
    expect(result.done).toBe(false);
    expect(result.error).toBeNull();
    expect(bunJsonl.parse('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
  });

  it("retains a valid prefix on a malformed record and throws only without one", () => {
    const result = bunJsonl.parseChunk('{"a":1}\n{bad}\n');
    expect(result.values).toEqual([{ a: 1 }]);
    expect(result.read).toBe(7);
    expect(result.done).toBe(false);
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(result.error?.message).toBe("Failed to parse JSONL");

    expect(bunJsonl.parse('{"a":1}\n{bad}\n')).toEqual([{ a: 1 }]);
    expect(() => bunJsonl.parse("{bad}\n")).toThrow(SyntaxError);
  });
});

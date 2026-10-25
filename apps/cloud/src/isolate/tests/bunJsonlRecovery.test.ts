import { describe, expect, it } from "@effect/vitest";

import { createBunShim } from "../BunShim.ts";

function createBun() {
  return createBunShim({
    env: {},
    main: "/cli",
    version: "1.4.3",
    onMissing: () => {},
  }).bun;
}

describe("Bun.JSONL recovery through the public shim", () => {
  it("reports invalid JSON inside an open container after keeping valid records", () => {
    const result = createBun().JSONL.parseChunk('{"a":1}\n{bad\n{"ok":1}\n');

    expect(result.values).toEqual([{ a: 1 }]);
    expect(result.read).toBe(7);
    expect(result.done).toBe(false);
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(result.error?.message).toBe("Failed to parse JSONL");
  });

  it("keeps a syntactically valid open container incomplete", () => {
    const result = createBun().JSONL.parseChunk('{"a":1}\n{"nested":\n');

    expect(result.values).toEqual([{ a: 1 }]);
    expect(result.read).toBe(7);
    expect(result.done).toBe(false);
    expect(result.error).toBeNull();
  });

  it("matches Bun EOF handling for terminal closers after a comma or colon", () => {
    const bun = createBun();
    for (const input of ['{"a":1,}', '{"a":}', "[1,]"]) {
      expect(bun.JSONL.parseChunk(input)).toEqual({
        values: [],
        read: 0,
        done: false,
        error: null,
      });
      expect(bun.JSONL.parse(input)).toEqual([]);

      for (const suffix of ["\n", " ", "\r"]) {
        const newlineResult = bun.JSONL.parseChunk(`${input}${suffix}`);
        expect(newlineResult.values).toEqual([]);
        expect(newlineResult.read).toBe(0);
        expect(newlineResult.done).toBe(false);
        expect(newlineResult.error).toBeInstanceOf(SyntaxError);
        expect(() => bun.JSONL.parse(`${input}${suffix}`)).toThrow(SyntaxError);
      }
    }
  });

  it("keeps byte offsets at the last valid record for incomplete and malformed tails", () => {
    const bun = createBun();
    const prefix = '{"é":"😀"}\n';
    const read = new TextEncoder().encode(prefix.slice(0, -1)).byteLength;

    const incomplete = bun.JSONL.parseChunk(new TextEncoder().encode(`${prefix}{"a":1,}`));
    expect(incomplete.values).toEqual([{ é: "😀" }]);
    expect(incomplete.read).toBe(read);
    expect(incomplete.done).toBe(false);
    expect(incomplete.error).toBeNull();

    const malformed = bun.JSONL.parseChunk(new TextEncoder().encode(`${prefix}{"a":1,}\n`));
    expect(malformed.values).toEqual([{ é: "😀" }]);
    expect(malformed.read).toBe(read);
    expect(malformed.done).toBe(false);
    expect(malformed.error).toBeInstanceOf(SyntaxError);
  });

  it("reports byte offsets without re-encoding each parsed prefix", () => {
    const text = Array.from({ length: 256 }, (_, index) =>
      JSON.stringify({ index, value: "é😀".repeat(8) }),
    ).join("\n");
    const bytes = new TextEncoder().encode(text);
    const nativeEncode = TextEncoder.prototype.encode;
    let encodedCodeUnits = 0;
    TextEncoder.prototype.encode = function (input?: string) {
      encodedCodeUnits += input?.length ?? 0;
      return nativeEncode.call(this, input);
    };

    const result = (() => {
      try {
        return createBun().JSONL.parseChunk(bytes);
      } finally {
        TextEncoder.prototype.encode = nativeEncode;
      }
    })();

    expect(result.values).toHaveLength(256);
    expect(result.read).toBe(bytes.byteLength);
    expect(result.done).toBe(true);
    expect(result.error).toBeNull();
    expect(encodedCodeUnits).toBeLessThanOrEqual(text.length);
  });
});

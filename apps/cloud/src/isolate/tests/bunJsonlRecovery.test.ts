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

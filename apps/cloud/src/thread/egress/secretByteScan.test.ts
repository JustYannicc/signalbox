import { describe, expect, it } from "vite-plus/test";

import { redactEgressResponse } from "../EgressResponse.ts";

const streamChunks = (chunks: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const readToFailure = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let error: unknown;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
  } catch (cause) {
    error = cause;
  }
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, error };
};

const redactBinaryChunks = async (
  chunks: ReadonlyArray<Uint8Array>,
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const response = await redactEgressResponse(
    new Response(streamChunks(chunks), {
      headers: { "content-type": "application/octet-stream" },
    }),
    secrets,
  );
  return readToFailure(response.body!);
};

describe("binary egress response", () => {
  it.each([
    ["7 ASCII bytes", "1234567", 7, false],
    ["8 ASCII bytes", "12345678", 8, true],
    ["7 UTF-8 bytes", "aééé", 7, false],
    ["8 UTF-8 bytes", "aéééx", 8, true],
  ] as const)("applies the binary threshold to %s", async (_kind, value, byteLength, blocked) => {
    const bytes = new TextEncoder().encode(value);
    expect(bytes.byteLength).toBe(byteLength);
    const result = await redactBinaryChunks(
      [...bytes].map((byte) => new Uint8Array([byte])),
      [{ name: "BOUNDARY", value }],
    );
    const message = result.error instanceof Error ? result.error.message : "";

    if (blocked) {
      expect(message.includes("BOUNDARY")).toBe(true);
      expect(message.includes(value)).toBe(false);
      expect(new TextDecoder().decode(result.bytes).includes(value)).toBe(false);
    } else {
      expect(result.error).toBeUndefined();
      expect([...result.bytes]).toEqual([...bytes]);
    }
  });

  it("blocks overlapping suffix patterns across one-byte chunks with names only", async () => {
    const secret = "abcdefghij";
    const suffix = "cdefghij";
    const bytes = new TextEncoder().encode(`public-${secret}-tail`);
    const result = await redactBinaryChunks(
      [...bytes].map((byte) => new Uint8Array([byte])),
      [
        { name: "LONG", value: secret },
        { name: "SUFFIX", value: suffix },
        { name: "ALIAS", value: secret },
      ],
    );
    const message = result.error instanceof Error ? result.error.message : "";

    expect(message.includes("LONG")).toBe(true);
    expect(message.includes("ALIAS")).toBe(true);
    expect(message.includes(secret)).toBe(false);
    expect(message.includes(suffix)).toBe(false);
    expect(new TextDecoder().decode(result.bytes).includes(secret)).toBe(false);
  });

  it("preserves large binary bodies byte for byte", async () => {
    const body = Uint8Array.from({ length: 128 * 1024 }, (_, index) => (index * 37) % 256);
    const chunks = Array.from({ length: 64 }, (_, index) =>
      body.subarray(index * 2048, (index + 1) * 2048),
    );
    const result = await redactBinaryChunks(chunks, [{ name: "KEY", value: "not-present" }]);

    expect(result.error).toBeUndefined();
    expect([...result.bytes]).toEqual([...body]);
  });
});

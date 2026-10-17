import { describe, expect, it } from "vite-plus/test";

import { scanSecretBytes } from "./secretByteScan.ts";

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

describe("scanSecretBytes", () => {
  it("blocks short and suffix matches across one-byte chunks with names only", async () => {
    const secret = "she";
    const bytes = new TextEncoder().encode(`public-${secret}-tail`);
    const result = await readToFailure(
      streamChunks([...bytes].map((byte) => new Uint8Array([byte]))).pipeThrough(
        scanSecretBytes([
          { name: "SHE", value: secret },
          { name: "HE", value: "he" },
          { name: "ALIAS", value: secret },
        ]),
      ),
    );
    const message = result.error instanceof Error ? result.error.message : "";

    expect(message.includes("SHE")).toBe(true);
    expect(message.includes("ALIAS")).toBe(true);
    expect(message.includes(secret)).toBe(false);
    expect(message.includes("he")).toBe(false);
    expect(new TextDecoder().decode(result.bytes).includes(secret)).toBe(false);
  });

  it("preserves large binary bodies byte for byte", async () => {
    const body = Uint8Array.from({ length: 128 * 1024 }, (_, index) => (index * 37) % 256);
    const chunks = Array.from({ length: 64 }, (_, index) =>
      body.subarray(index * 2048, (index + 1) * 2048),
    );
    const result = await readToFailure(
      streamChunks(chunks).pipeThrough(scanSecretBytes([{ name: "KEY", value: "not-present" }])),
    );

    expect(result.error).toBeUndefined();
    expect([...result.bytes]).toEqual([...body]);
  });
});

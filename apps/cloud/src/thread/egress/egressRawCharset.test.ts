import { describe, expect, it } from "vite-plus/test";

import { redactEgressResponse } from "./egressResponse.ts";

const utf8 = new TextEncoder();
const ascii = "ascii-secret-12345";
const unicode = "clé-secrète-123456";
const chunks = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });

const consume = async (response: Response) => {
  const reader = response.body!.getReader();
  const delivered: Array<Uint8Array> = [];
  let error: unknown;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      delivered.push(item.value);
    }
  } catch (cause) {
    error = cause;
  }
  return { delivered, error };
};

describe("raw secret bytes in declared text", () => {
  it.each([
    ["windows-1252", unicode],
    ["utf-16le", ascii],
    ["utf-16be", ascii],
  ])("refuses reversible raw UTF-8 under %s across chunk boundaries", async (encoding, value) => {
    const bytes = utf8.encode(value);
    // These inputs decode successfully. Invalid odd-length UTF-16 already fails closed.
    expect(bytes.length % 2).toBe(0);
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    expect(decoded).not.toBe(value);
    const recovered = Buffer.from(decoded, encoding === "windows-1252" ? "latin1" : "utf16le");
    if (encoding === "utf-16be") recovered.swap16();
    expect(new Uint8Array(recovered)).toEqual(bytes);

    const response = await redactEgressResponse(
      new Response(chunks(bytes), {
        headers: { "content-type": `text/plain; charset=${encoding}` },
      }),
      [{ name: "KEY", value }],
    );
    const result = await consume(response);
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain("registered secret: KEY");
    expect(String(result.error)).not.toContain(value);
    expect(result.delivered).toEqual([]);
  });

  it("checks decompressed raw bytes before the declared decoder", async () => {
    const compressed = new Uint8Array(
      await new Response(
        new Blob([utf8.encode(ascii)]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const response = await redactEgressResponse(
      new Response(chunks(compressed), {
        headers: { "content-type": "text/plain; charset=utf-16le", "content-encoding": "gzip" },
      }),
      [{ name: "KEY", value: ascii }],
    );
    const result = await consume(response);
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain("registered secret: KEY");
    expect(result.delivered).toEqual([]);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("redacts UTF-8 normally instead of refusing its raw matching bytes", async () => {
    const response = await redactEgressResponse(
      new Response(chunks(utf8.encode(unicode)), { headers: { "content-type": "text/plain" } }),
      [{ name: "KEY", value: unicode }],
    );
    expect(await response.text()).toBe("{{secret:KEY}}");
  });

  it.each(["windows-1252", "utf-16le", "utf-16be"])(
    "redacts correctly encoded long values in %s text",
    async (encoding) => {
      const encoded = Buffer.from(unicode, encoding === "windows-1252" ? "latin1" : "utf16le");
      if (encoding === "utf-16be") encoded.swap16();
      const response = await redactEgressResponse(
        new Response(chunks(encoded), {
          headers: { "content-type": `text/plain; charset=${encoding}` },
        }),
        [{ name: "KEY", value: unicode }],
      );
      expect(await response.text()).toBe("{{secret:KEY}}");
    },
  );

  it("keeps the eight-byte floor for raw mismatched text", async () => {
    const value = "ééé";
    const response = await redactEgressResponse(
      new Response(chunks(utf8.encode(value)), {
        headers: { "content-type": "text/plain; charset=windows-1252" },
      }),
      [{ name: "KEY", value }],
    );
    expect(await response.text()).toBe("Ã©Ã©Ã©");
  });
});

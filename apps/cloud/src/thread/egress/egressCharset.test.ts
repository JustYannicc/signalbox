import { describe, expect, it, vi } from "vite-plus/test";

import { redactEgressResponse } from "../EgressResponse.ts";

const utf8 = new TextEncoder();
const values = ["1", "abc", 'a"b', "abcdefg", "sk-throwaway-charset-fixture", "é"];
const encodings = ["us-ascii", "iso-8859-1", "windows-1252", "utf-16", "utf-16le", "utf-16be"];

const encode = (text: string, encoding: string) => {
  if (!encoding.startsWith("utf-16")) {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  }
  const littleEndian = encoding !== "utf-16be";
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let index = 0; index < text.length; index++) {
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
  }
  return bytes;
};

const chunks = (parts: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

const formsOf = (value: string) => {
  const bytes = utf8.encode(value);
  return [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    btoa(String.fromCharCode(...bytes)),
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  ];
};

const readUntilError = async (response: Response) => {
  const reader = response.body!.getReader();
  const parts: Array<string> = [];
  const decoder = new TextDecoder();
  let error: unknown;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      parts.push(decoder.decode(item.value, { stream: true }));
    }
  } catch (cause) {
    error = cause;
  }
  return { text: parts.join(""), error };
};

describe("egress text charsets", () => {
  it.each(encodings)("redacts raw and encoded values from chunked %s text", async (encoding) => {
    for (const value of values) {
      const forms = formsOf(value);
      const bytes = encode(forms.join("|"), encoding);
      const response = await redactEgressResponse(
        new Response(chunks([...bytes].map((byte) => new Uint8Array([byte]))), {
          headers: {
            "content-type": `text/plain; charset=${encoding}`,
            "content-length": String(bytes.length),
            etag: '"old-entity"',
            "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
          },
        }),
        [{ name: "KEY", value }],
      );
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("etag")).toBeNull();
      expect(text).toContain("{{secret:KEY}}");
      for (const form of forms) expect(text).not.toContain(form);
    }
  });

  it.each([
    "text/plain",
    "text/html",
    "application/json",
    "application/problem+json",
    "application/xml",
    "application/atom+xml",
    "application/x-www-form-urlencoded",
  ])("keeps %s on the text path regardless of charset", async (mime) => {
    const response = await redactEgressResponse(
      new Response(encode("abc", "utf-16be"), {
        headers: { "content-type": `${mime}; charset="utf-16be"` },
      }),
      [{ name: "KEY", value: "abc" }],
    );
    expect(await response.text()).toBe("{{secret:KEY}}");
    expect(response.headers.get("content-type")).toBe(`${mime}; charset=utf-8`);
  });

  it.each(["us-ascii", "iso-8859-1", "windows-1252"])(
    "uses WHATWG windows-1252 decoding for clean %s text",
    async (encoding) => {
      const response = await redactEgressResponse(
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]), {
          headers: { "content-type": `text/plain; charset=${encoding}` },
        }),
        [],
      );
      expect(await response.text()).toBe("café €");
    },
  );

  it.each(["utf-16", "utf-16le", "utf-16be"])(
    "decodes split BOMs, code units and surrogate pairs in clean %s text",
    async (encoding) => {
      const bytes = encode("café 猫 😺", encoding);
      const response = await redactEgressResponse(
        new Response(chunks([...bytes].map((byte) => new Uint8Array([byte]))), {
          headers: { "content-type": `text/plain; charset=${encoding}` },
        }),
        [],
      );
      expect(await response.text()).toBe("café 猫 😺");
    },
  );

  it.each(["gzip", "deflate", "br"])("decodes %s before charset redaction", async (encoding) => {
    const encoded = encode("café abc 616263 YWJj", "utf-16le");
    const compressed = new Uint8Array(
      await new Response(
        new Blob([encoded])
          .stream()
          .pipeThrough(
            new CompressionStream((encoding === "br" ? "brotli" : encoding) as CompressionFormat),
          ),
      ).arrayBuffer(),
    );
    const response = await redactEgressResponse(
      new Response(chunks([...compressed].map((byte) => new Uint8Array([byte]))), {
        headers: { "content-type": "text/plain; charset=utf-16le", "content-encoding": encoding },
      }),
      [{ name: "KEY", value: "abc" }],
    );
    expect(await response.text()).toBe("café {{secret:KEY}} {{secret:KEY}} {{secret:KEY}}");
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it.each(["x-unknown", "", '"utf-8', "utf-8; charset=utf-16le"])(
    "refuses invalid or unsupported charset %j without delivering the original body",
    async (label) => {
      let cancelled = false;
      const response = await redactEgressResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelled = true;
            },
          }),
          {
            headers: { "content-type": `text/plain; charset=${label}` },
          },
        ),
        [{ name: "KEY", value: "abc" }],
      );
      expect(response.status).toBe(403);
      expect(cancelled).toBe(true);
      expect(await response.text()).not.toContain("abc");
    },
  );

  it("refuses a charset unavailable in the runtime without exposing constructor errors", async () => {
    vi.stubGlobal("TextDecoder", function unavailableDecoder() {
      throw new Error("decoder-secret-canary");
    });
    try {
      const response = await redactEgressResponse(
        new Response(utf8.encode("abc"), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        [{ name: "KEY", value: "abc" }],
      );
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain("abc");
      expect(body).not.toContain("decoder-secret-canary");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["utf-8", new Uint8Array([0xc3, 0x28])],
    ["utf-16le", new Uint8Array([0x61])],
    ["utf-16be", new Uint8Array([0xd8, 0x00])],
  ])("aborts invalid %s text rather than returning unredacted bytes", async (encoding, invalid) => {
    const response = await redactEgressResponse(
      new Response(chunks([encode("abc", encoding), invalid]), {
        headers: { "content-type": `text/plain; charset=${encoding}` },
      }),
      [{ name: "KEY", value: "abc" }],
    );
    const result = await readUntilError(response);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain("abc");
  });

  it("scrubs a long unknown-type UTF-8 body across a partial code point at the sniff limit", async () => {
    const bytes = utf8.encode(`${"z".repeat(65_535)}€|abc|616263|YWJj`);
    const response = await redactEgressResponse(
      new Response(
        chunks([bytes.slice(0, 65_536), bytes.slice(65_536, 65_537), bytes.slice(65_537)]),
        {
          headers: { "content-type": "application/x-unknown" },
        },
      ),
      [{ name: "KEY", value: "abc" }],
    );
    expect(await response.text()).toBe(
      `${"z".repeat(65_535)}€|{{secret:KEY}}|{{secret:KEY}}|{{secret:KEY}}`,
    );
  });

  it("fails safely when an unknown body becomes invalid UTF-8 after its text prefix", async () => {
    const response = await redactEgressResponse(
      new Response(
        chunks([utf8.encode("z".repeat(65_536)), utf8.encode("abc"), new Uint8Array([0xff])]),
      ),
      [{ name: "KEY", value: "abc" }],
    );
    const result = await readUntilError(response);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain("abc");
  });

  it("keeps known binary MIME types byte-exact despite a long textual prefix", async () => {
    const bytes = utf8.encode(`${"z".repeat(70_000)}abc|YWJj`);
    const response = await redactEgressResponse(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
      [{ name: "KEY", value: "abc" }],
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { redactEgressResponse } from "./egressResponse.ts";

const secret = "sk-throwaway-response-fixture";
const secretBytes = new TextEncoder().encode(secret);
const secretValue = [{ name: "KEY", value: secret }];

const responseBytes = (bytes: Uint8Array, headers: HeadersInit = {}) =>
  new Response(bytes.slice().buffer, {
    headers: { "content-type": "application/octet-stream", ...headers },
  });

const readToFailure = async (response: Response) => {
  const reader = response.body!.getReader();
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
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, error };
};

const streamChunks = (chunks: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe("redactEgressResponse", () => {
  it("preserves clean binary bytes and scrubs headers", async () => {
    const body = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff, 0x80, 0x01]);
    const response = await redactEgressResponse(
      new Response(body, {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.byteLength),
          "content-range": `bytes 0-${body.byteLength - 1}/${body.byteLength}`,
          etag: '"fixture-v1"',
          "x-echo": secret,
        },
      }),
      secretValue,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("x-echo")).toBe("{{secret:KEY}}");
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-${body.byteLength - 1}/${body.byteLength}`,
    );
    expect(response.headers.get("etag")).toBe('"fixture-v1"');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...body]);
  });

  it("drops representation headers when scrubbing invalidates one", async () => {
    const response = await redactEgressResponse(
      new Response(new Uint8Array([0x50, 0x41, 0x43, 0x4b]), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "4",
          "content-range": "bytes 0-3/4",
          etag: secret,
        },
      }),
      secretValue,
    );

    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
  });

  it("drops invalidated representation headers when the response has no body", async () => {
    const response = await redactEgressResponse(
      new Response(null, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "4",
          etag: secret,
        },
      }),
      secretValue,
    );

    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
  });

  it("scrubs textual content with an unknown content type", async () => {
    const response = await redactEgressResponse(
      new Response(new TextEncoder().encode(secret)),
      secretValue,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{{secret:KEY}}");
  });

  it("keeps clean non-UTF-8 declared text byte-exact", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const response = await redactEgressResponse(
      new Response(body, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
      secretValue,
    );

    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...body]);
  });

  it("stops a non-UTF-8 declared text response when raw secret bytes occur", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, ...secretBytes]);
    const response = await redactEgressResponse(
      new Response(body, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
      secretValue,
    );
    const result = await readToFailure(response);
    const message = result.error instanceof Error ? result.error.message : "";

    expect(response.status).toBe(200);
    expect(message.includes("KEY")).toBe(true);
    expect(message.includes(secret)).toBe(false);
    expect(new TextDecoder().decode(result.bytes).includes(secret)).toBe(false);
  });

  it("continues text redaction for UTF-8 text and drops representation headers", async () => {
    const body = new TextEncoder().encode(`prefix ${secret}`);
    const response = await redactEgressResponse(
      new Response(body, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(body.byteLength),
          etag: '"fixture-v1"',
        },
      }),
      secretValue,
    );

    expect(await response.text()).toBe("prefix {{secret:KEY}}");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
  });

  it.each([
    ["one-character", "1", "31"],
    ["three-character", "abc", "616263"],
    ["seven-character", "1234567", "31323334353637"],
  ])("redacts raw and encoded %s values in UTF-8 text across chunks", async (_kind, value, hex) => {
    const text = `${value}|${hex}`;
    const bytes = new TextEncoder().encode(text);
    const response = await redactEgressResponse(
      new Response(streamChunks([...bytes].map((byte) => new Uint8Array([byte]))), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      [{ name: "KEY", value }],
    );

    expect(await response.text()).toBe("{{secret:KEY}}|{{secret:KEY}}");
  });

  it("passes short registered values through binary responses", async () => {
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const response = await redactEgressResponse(
      responseBytes(body, { "content-type": "application/octet-stream" }),
      [{ name: "ZIP", value: "PK" }],
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...body]);
  });

  it("keeps large unknown-type UTF-8 bodies on the exact binary scan path", async () => {
    const body = new TextEncoder().encode(`${"ascii prefix ".repeat(6_000)}archive tail`);
    const response = await redactEgressResponse(
      new Response(body, { headers: { "content-type": "application/x-unknown" } }),
      secretValue,
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...body]);
  });

  it.each([
    ["overlapping", "OVERLAP", "abababab", "OTHER", "baba"],
    ["UTF-8", "UNICODE", "pāss-猫", "OTHER", "āss-猫"],
  ])(
    "blocks %s secret bytes across every chunk boundary",
    async (_kind, name, value, otherName, otherValue) => {
      const values = [
        { name, value },
        { name: otherName, value: otherValue },
      ];
      const bytes = new TextEncoder().encode(value);
      for (let split = 1; split < bytes.length; split += 1) {
        const response = await redactEgressResponse(
          new Response(streamChunks([bytes.slice(0, split), bytes.slice(split)]), {
            headers: { "content-type": "application/octet-stream" },
          }),
          values,
        );
        const result = await readToFailure(response);
        const message = result.error instanceof Error ? result.error.message : "";

        expect(response.status).toBe(200);
        expect(message.includes(name) || message.includes(otherName)).toBe(true);
        expect(message.includes(value)).toBe(false);
        expect(new TextDecoder().decode(result.bytes).includes(value)).toBe(false);
      }
    },
  );

  it.each(["gzip", "deflate", "br"])("scans the decoded %s binary entity", async (encoding) => {
    const bytes = new TextEncoder().encode(`prefix\0${secret}suffix\xff`);
    const compressed = new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(
          new CompressionStream((encoding === "br" ? "brotli" : encoding) as CompressionFormat),
        ),
    );
    const response = await redactEgressResponse(
      new Response(await compressed.arrayBuffer(), {
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": encoding,
          "content-length": "1",
          etag: "stale",
        },
      }),
      secretValue,
    );
    const result = await readToFailure(response);
    const message = result.error instanceof Error ? result.error.message : "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(message.includes("KEY")).toBe(true);
    expect(message.includes(secret)).toBe(false);
    expect(new TextDecoder().decode(result.bytes).includes(secret)).toBe(false);
  });

  it.each(["gzip", "deflate", "br"])("preserves a clean decoded %s entity", async (encoding) => {
    const bytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff, 0x80, 0x01]);
    const compressed = await new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(
          new CompressionStream((encoding === "br" ? "brotli" : encoding) as CompressionFormat),
        ),
    ).arrayBuffer();
    const response = await redactEgressResponse(
      new Response(compressed, {
        headers: { "content-type": "application/octet-stream", "content-encoding": encoding },
      }),
      secretValue,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each(["gzip", "deflate", "br"])("fails closed on malformed %s content", async (encoding) => {
    const response = await redactEgressResponse(
      responseBytes(secretBytes, { "content-encoding": encoding }),
      secretValue,
    );
    const result = await readToFailure(response);

    expect(result.error).toBeDefined();
    expect(result.bytes.length).toBe(0);
    expect(String(result.error).includes(secret)).toBe(false);
  });

  it("fails closed on unsupported content encodings", async () => {
    const response = await redactEgressResponse(
      responseBytes(secretBytes, { "content-encoding": "x-unknown" }),
      secretValue,
    );

    expect(response.status).toBe(403);
    expect((await response.text()).includes(secret)).toBe(false);
  });

  it("leaves response bodies lazy and forwards cancellation", async () => {
    let pulls = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(secretBytes.length + 128).fill(0x41));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    expect(pulls).toBe(0);
    const response = await redactEgressResponse(
      new Response(source, { headers: { "content-type": "application/octet-stream" } }),
      secretValue,
    );
    expect(pulls).toBe(0);

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("preserves upstream body errors", async () => {
    const failure = new Error("upstream failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    const response = await redactEgressResponse(
      new Response(source, { headers: { "content-type": "application/octet-stream" } }),
      secretValue,
    );
    const error = await response
      .body!.getReader()
      .read()
      .catch((cause: unknown) => cause);

    expect(error === failure).toBe(true);
  });
});

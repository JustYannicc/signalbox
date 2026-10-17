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
        headers: { "content-type": "application/octet-stream", "x-echo": secret },
      }),
      secretValue,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe("{{secret:KEY}}");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...body]);
  });

  it("scrubs textual content with an unknown content type", async () => {
    const response = await redactEgressResponse(
      new Response(new TextEncoder().encode(secret)),
      secretValue,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{{secret:KEY}}");
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
    ["overlapping", "OVERLAP", "abababa", "OTHER", "baba"],
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

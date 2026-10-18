import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native WebStream backpressure needs an actual event-loop turn, not an Effect scheduler yield.
import * as NodeTimersPromises from "node:timers/promises";

import { redactEgressResponse } from "../EgressResponse.ts";
import { REFUSED_HEADER } from "../Egress.ts";
import { serveWithFakeNetwork as serveEgress } from "../tests/egressTestKit.ts";

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
  it.each(["", '{"proof":"'])(
    "refuses an initial binary secret before serveEgress returns a success response: %s",
    async (prefix) => {
      let approved = false;
      const response = await serveEgress(
        new Request("https://echo.example.test/binary?proof={{secret:KEY}}"),
        {
          ownHosts: new Set(),
          thread: {
            secrets: async () => ({
              current: secretValue,
              values: secretValue,
              registered: 1,
              registeredRunId: "binary-refusal",
              revision: 1,
            }),
            authorize: async () => {
              approved = true;
              return { _tag: "allowed" };
            },
          },
          send: async () =>
            new Response(streamChunks([new TextEncoder().encode(`${prefix}${secret}`)]), {
              headers: { "content-type": "application/octet-stream", proof: secret },
            }),
        },
      );

      expect(approved).toBe(true);
      expect(response.status).toBe(403);
      expect(response.headers.get(REFUSED_HEADER)).toBe("secret");
      expect((await response.text()).includes(secret)).toBe(false);
    },
  );
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

  it("transcodes clean declared Latin-1 text to UTF-8", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const response = await redactEgressResponse(
      new Response(body, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
      secretValue,
    );

    expect(await response.text()).toBe("café");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("redacts a declared Latin-1 text response", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, ...secretBytes]);
    const response = await redactEgressResponse(
      new Response(body, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
      secretValue,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("café {{secret:KEY}}");
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

  it("keeps large clean unknown-type UTF-8 bodies readable", async () => {
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
        expect(response.status).toBe(403);
        expect(response.headers.get(REFUSED_HEADER)).toBe("secret");
        expect((await response.text()).includes(value)).toBe(false);
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
    expect(response.status).toBe(403);
    expect(response.headers.get(REFUSED_HEADER)).toBe("secret");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect((await response.text()).includes(secret)).toBe(false);
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

    expect(response.status).toBe(403);
    expect(response.headers.get(REFUSED_HEADER)).toBe("secret");
    expect(result.error).toBeUndefined();
    expect(new TextDecoder().decode(result.bytes).includes(secret)).toBe(false);
  });

  it("fails closed on unsupported content encodings", async () => {
    const response = await redactEgressResponse(
      responseBytes(secretBytes, { "content-encoding": "x-unknown" }),
      secretValue,
    );

    expect(response.status).toBe(403);
    expect((await response.text()).includes(secret)).toBe(false);
  });

  it.each([false, true])(
    "bounds binary preflight read-ahead and forwards cancellation after replay=%s",
    async (replay) => {
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
      // pipeThrough can queue one write beyond the primed chunk. Assert the
      // settled backpressure bound, not which microtask finishes prefetching.
      await NodeTimersPromises.setImmediate();
      expect(pulls).toBeGreaterThanOrEqual(1);
      expect(pulls).toBeLessThanOrEqual(2);
      const primedPulls = pulls;

      const reader = response.body!.getReader();
      if (replay) {
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value).toEqual(new Uint8Array(129).fill(0x41));
        await NodeTimersPromises.setImmediate();
        expect(pulls).toBe(primedPulls);
      }
      await reader.cancel();
      expect(cancelled).toBe(true);
      await NodeTimersPromises.setImmediate();
      expect(pulls).toBe(primedPulls);
    },
  );

  it("refuses an initial upstream binary error without exposing its message", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`upstream failed: ${secret}`));
      },
    });
    const response = await redactEgressResponse(
      new Response(source, { headers: { "content-type": "application/octet-stream" } }),
      secretValue,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get(REFUSED_HEADER)).toBe("secret");
    expect((await response.text()).includes(secret)).toBe(false);
  });

  it("preserves a late upstream binary error after replaying the primed chunk", async () => {
    const failure = new Error("late upstream failure");
    let fail: (() => void) | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(secretBytes.length + 128).fill(0x41));
        fail = () => controller.error(failure);
      },
    });
    const response = await redactEgressResponse(
      new Response(source, { headers: { "content-type": "application/octet-stream" } }),
      secretValue,
    );
    const reader = response.body!.getReader();
    expect(response.status).toBe(200);
    expect((await reader.read()).value).toEqual(new Uint8Array(129).fill(0x41));
    if (fail === undefined) throw new Error("expected the upstream failure control");
    fail();
    const error = await reader.read().catch((cause: unknown) => cause);
    expect(error === failure).toBe(true);
  });

  it("keeps a late secret failure after a safe prefix without returning matched bytes", async () => {
    let append: (() => void) | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(secretBytes.length + 128).fill(0x41));
        append = () => {
          controller.enqueue(new TextEncoder().encode(`public-tail:${secret}`));
          controller.close();
        };
      },
    });
    const response = await redactEgressResponse(
      new Response(source, { headers: { "content-type": "application/octet-stream" } }),
      secretValue,
    );
    const reader = response.body!.getReader();
    expect(response.status).toBe(200);
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array(129).fill(0x41));
    if (append === undefined) throw new Error("expected the upstream chunk control");
    append();
    let delivered = new TextDecoder().decode(first.value);
    let failure: unknown;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        delivered += new TextDecoder().decode(item.value);
      }
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("KEY");
    expect(delivered.startsWith("A".repeat(129))).toBe(true);
    expect(delivered.includes(secret)).toBe(false);
    expect(String(failure).includes(secret)).toBe(false);
  });

  it.each(["text/plain", "application/x-unknown"])(
    "keeps %s response bodies lazy and cancellation connected",
    async (contentType) => {
      let pulls = 0;
      let cancelled = false;
      const source = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("safe text"));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = await redactEgressResponse(
        new Response(source, { headers: { "content-type": contentType } }),
        secretValue,
      );
      expect(pulls).toBe(0);
      await response.body!.cancel();
      expect(cancelled).toBe(true);
    },
  );
});

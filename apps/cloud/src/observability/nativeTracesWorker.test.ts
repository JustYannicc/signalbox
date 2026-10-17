import { describe, expect, it } from "@effect/vitest";

import { MAX_COMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES } from "./nativeTracesBody.ts";
import { type NativeTracesEnv, handleTraceExport, sentryTraces } from "./nativeTracesWorker.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const env: NativeTracesEnv = {
  SENTRY_DSN: `https://${KEY}@o1.ingest.de.sentry.io/4500000000000001`,
  TRACE_EXPORT_TOKEN: KEY,
  SIGNALBOX_STAGE: "pr-680",
  APP_VERSION: "b3c6ae8e5f",
};
const SENTRY_URL = "https://o1.ingest.de.sentry.io/api/4500000000000001/integration/otlp/v1/traces";
const TRACE = "0abcdef0123456789abcdef012345678";

/** One D1 span carrying a binding count and a URL, as Cloudflare exports them. */
const exportBody = JSON.stringify({
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "signalbox-cloud" } }],
      },
      scopeSpans: [
        {
          scope: { name: "canary-scope" },
          spans: [
            {
              traceId: TRACE,
              spanId: "1111111111111111",
              name: "d1_run",
              startTimeUnixNano: "1760000000000000000",
              endTimeUnixNano: "1760000000001000000",
              attributes: [
                { key: "db.query.text", value: { stringValue: "SELECT ? -- canary-sql" } },
                {
                  key: "cloudflare.d1.query.bindings",
                  value: { intValue: "1" },
                },
                { key: "url.full", value: { stringValue: "https://x.example/canary-url" } },
                { key: "cloudflare.d1.response.rows_read", value: { intValue: "2" } },
              ],
              events: [{ name: "canary-event" }],
            },
          ],
        },
      ],
    },
  ],
});

const sentrySpan = {
  traceId: TRACE,
  spanId: "1111111111111111",
  name: "d1_run",
  startTimeUnixNano: "1760000000000000000",
  endTimeUnixNano: "1760000000001000000",
  attributes: [{ key: "cloudflare.d1.response.rows_read", value: { intValue: "2" } }],
};

const gzip = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

interface Call {
  readonly body?: BodyInit | undefined;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly path?: string;
  readonly env?: Partial<NativeTracesEnv>;
  readonly upstream?: () => Promise<Response>;
}

/** The receiver's answer and every request it sent on. */
const call = async (options: Call) => {
  const sent: Array<Request> = [];
  const response = await handleTraceExport(
    new Request(`https://traces.signalbox.example${options.path ?? "/v1/traces"}`, {
      method: options.method ?? "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        ...options.headers,
      },
      ...(options.body !== undefined && { body: options.body }),
    }),
    { ...env, ...options.env },
    async (request) => {
      sent.push(request);
      return options.upstream === undefined ? new Response("{}") : options.upstream();
    },
  );
  return { status: response.status, text: await response.text(), sent };
};

describe("handleTraceExport", () => {
  it("sends Sentry only the rebuilt export, with Sentry's key and no inbound header", async () => {
    const { status, text, sent } = await call({
      body: exportBody,
      headers: { cookie: "canary-cookie", "x-forwarded-for": "canary-ip" },
    });
    expect({ status, text }).toEqual({ status: 200, text: "{}" });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(SENTRY_URL);
    expect([...(request?.headers.keys() ?? [])].sort()).toEqual(["content-type", "x-sentry-auth"]);
    expect(request?.headers.get("x-sentry-auth")).toBe(`sentry sentry_key=${KEY}`);
    const forwarded = await request?.text();
    expect(JSON.parse(forwarded ?? "")).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "signalbox-cloud" } },
              { key: "deployment.environment.name", value: { stringValue: "pr-680" } },
              { key: "sentry.environment", value: { stringValue: "pr-680" } },
              { key: "service.version", value: { stringValue: "b3c6ae8e5f" } },
              { key: "sentry.release", value: { stringValue: "b3c6ae8e5f" } },
            ],
          },
          scopeSpans: [{ scope: { name: "signalbox.traces" }, spans: [sentrySpan] }],
        },
      ],
    });
    expect(forwarded).not.toContain("canary");
  });

  it("reads a gzip export the same as a plain one", async () => {
    const body = await gzip(new TextEncoder().encode(exportBody));
    const { status, sent } = await call({ body, headers: { "content-encoding": "gzip" } });
    expect(status).toBe(200);
    expect(JSON.parse((await sent[0]?.text()) ?? "").resourceSpans[0].scopeSpans[0].spans).toEqual([
      sentrySpan,
    ]);
  });

  it.each([
    { key: "cloudflare.d1.query.bindings", value: { stringValue: "canary-bound-value" } },
    { key: "message.content", value: { stringValue: "canary-message-text" } },
  ])("never sends a content-bearing span to Sentry: %j", async (attribute) => {
    const payload = JSON.parse(exportBody);
    payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.push(attribute);
    expect(await call({ body: JSON.stringify(payload) })).toEqual({
      status: 200,
      text: "{}",
      sent: [],
    });
  });

  it.each([
    ["no header", { authorization: "" }],
    ["another token", { authorization: "Bearer fedcba9876543210fedcba9876543210" }],
    ["a prefix of the token", { authorization: `Bearer ${KEY.slice(0, 31)}` }],
    ["another scheme", { authorization: `Basic ${KEY}` }],
  ])("turns away %s before reading anything", async (_, headers) => {
    expect(await call({ body: exportBody, headers })).toEqual({
      status: 401,
      text: "unauthorized",
      sent: [],
    });
  });

  it("turns everyone away while the token is unset", async () => {
    const reply = await call({ body: exportBody, env: { TRACE_EXPORT_TOKEN: "" } });
    expect(reply.status).toBe(401);
  });

  it("serves only POST /v1/traces", async () => {
    expect((await call({ path: "/v1/logs", body: exportBody })).status).toBe(404);
    expect((await call({ method: "GET" })).status).toBe(405);
  });

  it.each([
    ["an empty probe", undefined, {}],
    ["an empty export", "{}", {}],
    ["an empty probe without a type", "", { "content-type": "" }],
  ])("accepts %s without calling Sentry", async (_, body, headers) => {
    expect(await call({ body, headers })).toEqual({ status: 200, text: "{}", sent: [] });
  });

  it.each([
    ["broken JSON", "{canary", {}, 400],
    ["a JSON array", "[]", {}, 400],
    ["broken gzip", "canary-not-gzip", { "content-encoding": "gzip" }, 400],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d]), {}, 400],
    ["a non-JSON type", exportBody, { "content-type": "application/x-protobuf" }, 415],
    ["another encoding", exportBody, { "content-encoding": "br" }, 415],
    ["a declared oversize body", "{}", { "content-length": String(MAX_COMPRESSED_BYTES + 1) }, 413],
  ])("refuses %s with fixed text", async (_, body, headers, status) => {
    const reply = await call({ body, headers });
    expect(reply.status).toBe(status);
    expect(reply.text).not.toContain("canary");
    expect(reply.sent).toEqual([]);
  });

  it("stops reading a body past the compressed limit", async () => {
    const reply = await call({ body: new Uint8Array(MAX_COMPRESSED_BYTES + 1) });
    expect(reply).toEqual({ status: 413, text: "trace export too large", sent: [] });
  });

  it("stops inflating a gzip body past the decompressed limit", async () => {
    const body = await gzip(new Uint8Array(MAX_DECOMPRESSED_BYTES + 1));
    expect(body.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);
    const reply = await call({ body, headers: { "content-encoding": "gzip" } });
    expect(reply).toEqual({ status: 413, text: "trace export too large", sent: [] });
  });

  it("answers 502 with fixed text when Sentry refuses or can't be reached", async () => {
    const refused = await call({
      body: exportBody,
      upstream: async () => new Response("canary-upstream", { status: 429 }),
    });
    expect({ status: refused.status, text: refused.text }).toEqual({
      status: 502,
      text: "trace export failed upstream",
    });
    const unreachable = await call({
      body: exportBody,
      upstream: () => Promise.reject(new Error("canary-network")),
    });
    expect(unreachable.status).toBe(502);
    expect(unreachable.text).not.toContain("canary");
  });

  it("answers 500 without a usable DSN", async () => {
    const reply = await call({ body: exportBody, env: { SENTRY_DSN: "" } });
    expect({ status: reply.status, sent: reply.sent }).toEqual({ status: 500, sent: [] });
  });
});

describe("sentryTraces", () => {
  it("finds the OTLP endpoint for a DSN, under a path or not", () => {
    expect(sentryTraces(env.SENTRY_DSN)).toEqual({
      url: SENTRY_URL,
      auth: `sentry sentry_key=${KEY}`,
    });
    expect(sentryTraces(`https://${KEY}@sentry.example/base/7`)?.url).toBe(
      "https://sentry.example/base/api/7/integration/otlp/v1/traces",
    );
    expect(sentryTraces("not a dsn")).toBeNull();
    expect(sentryTraces("https://sentry.example/7")).toBeNull();
  });
});

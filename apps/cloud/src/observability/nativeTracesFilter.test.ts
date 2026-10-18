import { WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { filterTraces } from "./nativeTracesFilter.ts";

const trusted = { stage: "pr-680", version: "b3c6ae8e5f" };
const str = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const int = (key: string, intValue: string | number) => ({ key, value: { intValue } });

// Cloudflare leaves out the trace id's leading zero, as Sentry has shown it.
const SHORT_TRACE = "abcdef0123456789abcdef012345678";
const TRACE = `0${SHORT_TRACE}`;
const THREAD = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PERSON = "user_01HZY3K5Q8W2N4M6P7R9T0V1XA";

/** A native export, shaped like Cloudflare's, with a canary in every free-text place. */
const nativeExport = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          str("service.name", "signalbox-cloud-pr-680"),
          str("cloudflare.script_tags", "canary-resource"),
          str("person.id", "canary-person"),
        ],
      },
      schemaUrl: "https://canary-schema.example",
      scopeSpans: [
        {
          scope: { name: "canary-scope", version: "canary-scope-version" },
          schemaUrl: "https://canary-scope-schema.example",
          spans: [
            {
              traceId: SHORT_TRACE,
              spanId: "1111111111111111",
              name: "GET /drive/canary-path",
              kind: 2,
              startTimeUnixNano: "1760000000000000000",
              endTimeUnixNano: "1760000000012000000",
              traceState: "canary=tracestate",
              attributes: [
                str("faas.trigger", "http"),
                str("cloudflare.handler_type", "fetch"),
                str("cloudflare.outcome", "ok"),
                str("http.request.method", "GET"),
                int("http.response.status_code", 200),
                int("cloudflare.cpu_time_ms", "3"),
                { key: "cloudflare.wall_time_ms", value: { doubleValue: 12.5 } },
                str("url.full", "https://cloud.example/drive/canary-path?token=canary-query"),
                str("url.path", "/drive/canary-path"),
                str("url.query", "token=canary-query"),
                str("user_agent.original", "canary-agent"),
                str("cloudflare.ray_id", "canary-ray"),
                str("thread.id", THREAD),
                // A free-text value under an allowed key is dropped, not copied.
                str("cloudflare.execution_model", "canary-model"),
                str("http.request.method", "canary-duplicate"),
              ],
              events: [{ name: "canary-event" }],
              links: [{ traceId: TRACE, spanId: "2222222222222222", traceState: "canary-link" }],
              status: { code: 2 },
            },
            {
              traceId: SHORT_TRACE,
              spanId: "2222222222222222",
              parentSpanId: "1111111111111111",
              name: "durable_object_storage_exec",
              kind: "SPAN_KIND_CLIENT",
              startTimeUnixNano: 1_760_000_000_001_000,
              endTimeUnixNano: 1_760_000_000_002_000,
              attributes: [
                str("db.query.text", "INSERT INTO notes VALUES (?) -- canary-sql"),
                {
                  key: "cloudflare.durable_object.query.bindings",
                  value: { intValue: "1" },
                },
                int("cloudflare.durable_object.response.rows_written", "1"),
                int("cloudflare.durable_object.response.rows_read", -1),
              ],
            },
            {
              traceId: SHORT_TRACE,
              spanId: "3333333333333333",
              parentSpanId: "1111111111111111",
              name: "r2_get canary-file.txt",
              startTimeUnixNano: "1760000000003000000",
              endTimeUnixNano: "1760000000004000000",
              attributes: [
                str("cloudflare.r2.request.key", "canary-file.txt"),
                str("cloudflare.r2.error.name", "canary-error"),
                { key: "cloudflare.r2.response.success", value: { boolValue: false } },
              ],
            },
            // Unusable spans are dropped whole.
            { traceId: "zz", spanId: "4444444444444444", name: "canary-bad-trace" },
            {
              traceId: TRACE,
              spanId: "0000000000000000",
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              name: "canary-zero-span",
            },
          ],
        },
      ],
    },
  ],
};

describe("filterTraces", () => {
  it("rebuilds a native export from fixed names, bounded values and validated ids", () => {
    expect(filterTraces(nativeExport, trusted)).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              str("service.name", "signalbox-cloud"),
              str("deployment.environment.name", "pr-680"),
              str("sentry.environment", "pr-680"),
              str("service.version", "b3c6ae8e5f"),
              str("sentry.release", "b3c6ae8e5f"),
            ],
          },
          scopeSpans: [
            {
              scope: { name: "signalbox.traces" },
              spans: [
                {
                  traceId: TRACE,
                  spanId: "1111111111111111",
                  name: "http.server GET",
                  kind: 2,
                  startTimeUnixNano: "1760000000000000000",
                  endTimeUnixNano: "1760000000012000000",
                  attributes: [
                    str("faas.trigger", "http"),
                    str("cloudflare.handler_type", "fetch"),
                    str("cloudflare.outcome", "ok"),
                    str("http.request.method", "GET"),
                    int("http.response.status_code", "200"),
                    int("cloudflare.cpu_time_ms", "3"),
                    { key: "cloudflare.wall_time_ms", value: { doubleValue: 12.5 } },
                    str("thread.id", THREAD),
                  ],
                  status: { code: 2 },
                },
                {
                  traceId: TRACE,
                  spanId: "2222222222222222",
                  parentSpanId: "1111111111111111",
                  name: "durable_object_storage_exec",
                  kind: 3,
                  startTimeUnixNano: "1760000000001000",
                  endTimeUnixNano: "1760000000002000",
                  attributes: [int("cloudflare.durable_object.response.rows_written", "1")],
                },
                {
                  traceId: TRACE,
                  spanId: "3333333333333333",
                  parentSpanId: "1111111111111111",
                  name: "worker.operation",
                  startTimeUnixNano: "1760000000003000000",
                  endTimeUnixNano: "1760000000004000000",
                  attributes: [
                    { key: "cloudflare.r2.response.success", value: { boolValue: false } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(filterTraces(nativeExport, trusted))).not.toContain("canary");
  });

  it.each([
    {
      attributes: [
        {
          key: "cloudflare.durable_object.query.bindings",
          value: { arrayValue: { values: [{ stringValue: "canary-bound-value" }] } },
        },
      ],
    },
    { attributes: [str("cloudflare.d1.query.bindings", "canary-bound-value")] },
    { attributes: [str("message.content", "canary-message-text")] },
    { attributes: [str("exception.message", "canary-error-text")] },
    { events: [{ attributes: [str("gen_ai.prompt", "canary-prompt")] }] },
    { status: { code: 2, message: "canary-status-message" } },
  ])("drops a whole span carrying bound values or message text: %j", (content) => {
    const traces = filterTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE,
                    spanId: "1111111111111111",
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                    ...content,
                  },
                ],
              },
            ],
          },
        ],
      },
      trusted,
    );
    expect(traces).toEqual({ resourceSpans: [] });
  });

  it.each([
    "code",
    "state",
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "ticket",
    "api_key",
    "client_secret",
  ])("drops %s from query and full URL attributes", (key) => {
    const traces = filterTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE,
                    spanId: "1111111111111111",
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                    attributes: [
                      str("url.query", `${key}=canary-credential`),
                      str(
                        "url.full",
                        `https://example.com/oauth/callback?${key}=canary-credential`,
                      ),
                      str("http.url", `https://example.com/?${key}=canary-credential`),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      trusted,
    );
    expect(traces?.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(1);
    expect(traces?.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes).toEqual([]);
    expect(JSON.stringify(traces)).not.toContain("canary");
  });

  it("names a client's service and keeps its id dimensions on the same trace", () => {
    const traces = filterTraces(
      {
        resourceSpans: [
          {
            resource: {
              attributes: [
                str("service.name", "t3code-web"),
                str("person.id", PERSON),
                str("org.id", "org_01HZY3K5Q8W2N4M6P7R9T0V1XB"),
                str("folder.id", "canary-folder"),
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE,
                    spanId: "5555555555555555",
                    parentSpanId: "1111111111111111",
                    name: "web.canary.openDatabase",
                    kind: 1,
                    startTimeUnixNano: "1759999999999000000",
                    endTimeUnixNano: "1760000000013000000",
                    attributes: [
                      str("turn.id", `run:${THREAD}:3`),
                      str("automation.id", `${THREAD}-canary`),
                      str("code.filepath", "/canary/file.ts"),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { stage: "production", version: "" },
    );
    expect(traces?.resourceSpans[0]?.resource.attributes).toEqual([
      str("service.name", "t3code-web"),
      str("person.id", PERSON),
      str("org.id", "org_01HZY3K5Q8W2N4M6P7R9T0V1XB"),
      str("deployment.environment.name", "production"),
      str("sentry.environment", "production"),
    ]);
    expect(traces?.resourceSpans[0]?.scopeSpans[0]?.spans).toEqual([
      {
        traceId: TRACE,
        spanId: "5555555555555555",
        parentSpanId: "1111111111111111",
        name: "client.operation",
        kind: 1,
        startTimeUnixNano: "1759999999999000000",
        endTimeUnixNano: "1760000000013000000",
        attributes: [str("turn.id", `run:${THREAD}:3`)],
      },
    ]);
    expect(JSON.stringify(traces)).not.toContain("canary");
  });

  it.each([
    ["signalbox-model-gateway-pr-7", "signalbox-model-gateway"],
    ["t3code-mobile", "t3code-mobile"],
    ["signalbox-cloud-canary", "signalbox"],
    ["t3code-web-canary", "signalbox"],
  ])("stamps %s as the service %s", (source, service) => {
    const traces = filterTraces(
      {
        resourceSpans: [
          {
            resource: { attributes: [str("service.name", source)] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE,
                    spanId: "6666666666666666",
                    name: "fetch",
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                  },
                ],
              },
            ],
          },
        ],
      },
      { stage: "bad stage", version: "canary version" },
    );
    expect(traces?.resourceSpans[0]?.resource.attributes).toEqual([str("service.name", service)]);
    expect(traces?.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe("fetch");
  });

  it("keeps a root marked with an all-zero parent, and pads short ids", () => {
    const span = (spanId: string, parentSpanId?: string) => ({
      traceId: TRACE,
      spanId,
      ...(parentSpanId !== undefined && { parentSpanId }),
      name: "fetch",
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
    });
    const traces = filterTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  span("1111111111111111", "0000000000000000"),
                  span("2222222222222222", ""),
                  span("abc", "1111111111111111"),
                  span("3333333333333333", "def"),
                  span("4444444444444444", "canary-parent"),
                  span("0000000000000000"),
                ],
              },
            ],
          },
        ],
      },
      trusted,
    );
    const kept = traces?.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(kept.map(({ spanId, parentSpanId }) => ({ spanId, parentSpanId }))).toEqual([
      { spanId: "1111111111111111", parentSpanId: undefined },
      { spanId: "2222222222222222", parentSpanId: undefined },
      { spanId: "0000000000000abc", parentSpanId: "1111111111111111" },
      { spanId: "3333333333333333", parentSpanId: "0000000000000def" },
    ]);
    expect(kept[0]).not.toHaveProperty("parentSpanId");
  });

  it("refuses what isn't an export and keeps nothing from an empty one", () => {
    expect(filterTraces([], trusted)).toBeNull();
    expect(filterTraces({ resourceSpans: "canary" }, trusted)).toBeNull();
    expect(filterTraces({}, trusted)).toEqual({ resourceSpans: [] });
    expect(filterTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] }, trusted)).toEqual({
      resourceSpans: [],
    });
  });
});

describe("RPC trace filtering", () => {
  it("keeps only catalog methods and exact RPC names, without request parameters", () => {
    const method = WS_METHODS.accountPoolCreate;
    const names = [
      method,
      `RpcClient.${method}`,
      `RpcServer.${method}`,
      "canary?token=secret",
      `${method} canary-secret`,
    ];
    const result = filterTraces(
      {
        resourceSpans: [
          {
            resource: { attributes: [str("service.name", "signalbox-cloud")] },
            scopeSpans: [
              {
                spans: names.map((name, index) => ({
                  traceId: TRACE,
                  spanId: String(index + 1).repeat(16),
                  parentSpanId: "9999999999999999",
                  name,
                  kind: 2,
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  attributes: [
                    str("rpc.method", index < 3 ? method : `${method}?token=canary-secret`),
                    str("rpc.parameters", "canary-private-message"),
                    str("rpc.request", "canary-file-content"),
                  ],
                })),
              },
            ],
          },
        ],
      },
      trusted,
    );
    const spans = result?.resourceSpans[0]?.scopeSpans[0]?.spans;
    expect(spans?.map((span) => span.name)).toEqual([
      method,
      `RpcClient.${method}`,
      `RpcServer.${method}`,
      "worker.operation",
      "worker.operation",
    ]);
    expect(
      spans
        ?.slice(0, 3)
        .every((span) =>
          span.attributes?.some(
            (attribute) =>
              attribute.key === "rpc.method" &&
              "stringValue" in attribute.value &&
              attribute.value.stringValue === method,
          ),
        ),
    ).toBe(true);
    expect(spans?.slice(3).every((span) => span.attributes?.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(
      spans?.every((span) => span.traceId === TRACE && span.parentSpanId === "9999999999999999"),
    ).toBe(true);
  });
});

describe("client issue trace metadata", () => {
  it.each([128, 129])("bounds environment IDs at 128 characters: %s", (length) => {
    const input = structuredClone(nativeExport);
    const environmentId = "e".repeat(length);
    const release = "1.0.1-nightly.20260905.123";
    input.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes = [
      str("environment.id", environmentId),
      str("client.release", release),
      str("thread.id", "canary-private-".repeat(8)),
    ];
    const filtered = filterTraces(input, trusted);
    const attributes = filtered?.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
    expect(attributes).toEqual([
      ...(length === 128 ? [str("environment.id", environmentId)] : []),
      str("client.release", release),
    ]);
    expect(JSON.stringify(filtered)).not.toContain("canary-private");
  });
});

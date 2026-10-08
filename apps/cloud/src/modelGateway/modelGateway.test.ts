import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { ModelAuthorization } from "../thread/runner/ThreadRunner.ts";
import { handleModelRequest, type ModelGatewayDeps } from "./modelGateway.ts";
import type { ModelGatewayRecord } from "./modelGatewayRecord.ts";

const LIVE = "sbm1.dGhyZWFkLWE.live";
const runId = RunId.make("run-1");
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

const makeGateway = (options: {
  readonly upstream?: (request: Request) => Response;
  readonly authorize?: ModelGatewayDeps["authorize"];
  readonly withoutKeys?: boolean;
}) => {
  const forwarded: Array<Request> = [];
  const asked: Array<[string, ModelGatewayProvider]> = [];
  const logs: Array<ModelGatewayRecord> = [];
  const deps: ModelGatewayDeps = {
    authorize:
      options.authorize ??
      (async (token, provider): Promise<ModelAuthorization> => {
        asked.push([token, provider]);
        return token === LIVE
          ? { _tag: "granted", runId, traceId }
          : { _tag: "denied", reason: "This token is not for the running turn." };
      }),
    upstreams: options.withoutKeys
      ? { anthropic: null, openai: null }
      : {
          anthropic: { baseUrl: "https://anthropic.test/", apiKey: "sk-ant-real" },
          openai: { baseUrl: "https://openai.test", apiKey: "sk-openai-real" },
        },
    fetch: async (request) => {
      forwarded.push(request);
      return options.upstream?.(request) ?? new Response("ok");
    },
    now: () => 0,
    log: (record) => void logs.push(record),
  };
  const call = (path: string, init: RequestInit = {}) =>
    handleModelRequest(new Request(`http://gateway.test${path}`, init), deps);
  return { call, forwarded, asked, logs };
};

describe("ModelGateway", () => {
  it("forwards a live turn's request with the real key, never the token", async () => {
    const gateway = makeGateway({});
    const response = await gateway.call("/anthropic/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "x-api-key": LIVE,
        authorization: `Bearer ${LIVE}`,
        cookie: "a=b",
        "anthropic-version": "2023-06-01",
      },
      body: '{"model":"claude"}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(gateway.asked).toEqual([[LIVE, "anthropic"]]);

    const [upstream] = gateway.forwarded;
    expect(upstream?.url).toBe("https://anthropic.test/v1/messages?beta=true");
    expect(upstream?.headers.get("x-api-key")).toBe("sk-ant-real");
    expect(upstream?.headers.get("authorization")).toBeNull();
    expect(upstream?.headers.get("cookie")).toBeNull();
    expect(upstream?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(await upstream?.text()).toBe('{"model":"claude"}');
    expect(gateway.logs).toMatchObject([
      { provider: "anthropic", path: "/v1/messages", status: 200, runId, threadId: "thread-a" },
    ]);
  });

  it("sends OpenAI its key as a bearer token", async () => {
    const gateway = makeGateway({});
    await gateway.call("/openai/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${LIVE}` },
      body: "{}",
    });
    expect(gateway.forwarded[0]?.url).toBe("https://openai.test/v1/responses");
    expect(gateway.forwarded[0]?.headers.get("authorization")).toBe("Bearer sk-openai-real");
    expect(gateway.forwarded[0]?.headers.get("x-api-key")).toBeNull();
  });

  it("streams the response through as it arrives", async () => {
    let push: ((chunk: string) => void) | undefined;
    let end: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        end = () => controller.close();
      },
    });
    const gateway = makeGateway({
      upstream: () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
        }),
    });
    const response = await gateway.call("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LIVE },
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("content-encoding")).toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    push?.("event: message_start\n\n");
    // The first event is readable before the upstream has sent anything else.
    expect(decoder.decode((await reader.read()).value)).toBe("event: message_start\n\n");
    push?.("event: message_stop\n\n");
    expect(decoder.decode((await reader.read()).value)).toBe("event: message_stop\n\n");
    expect(gateway.logs).toEqual([]);
    end?.();
    expect((await reader.read()).done).toBe(true);
    expect(gateway.logs).toMatchObject([{ status: 200, firstChunkMs: 0, outcome: "complete" }]);
  });

  it("still records a response the harness stops reading", async () => {
    const gateway = makeGateway({
      upstream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message_start\n\n"));
            },
          }),
        ),
    });
    const response = await gateway.call("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LIVE },
      body: "{}",
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(gateway.logs).toMatchObject([{ status: 200, firstChunkMs: 0, outcome: "cancelled" }]);
  });

  it("turns down a token the thread does not grant, in the provider's error shape", async () => {
    const gateway = makeGateway({});
    const anthropic = await gateway.call("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sbm1.dGhyZWFkLWE.ended" },
    });
    expect(anthropic.status).toBe(401);
    expect(await anthropic.json()).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "This token is not for the running turn.",
      },
    });
    const openai = await gateway.call("/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sbm1.dGhyZWFkLWE.ended" },
    });
    expect(openai.status).toBe(401);
    expect(await openai.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect(gateway.forwarded).toEqual([]);
    expect(gateway.logs).toMatchObject([
      { status: 401, threadId: "thread-a", runId: null, traceId: null, usage: null },
      { status: 401, threadId: "thread-a", runId: null, traceId: null, usage: null },
    ]);
  });

  it("serves only a turn's model endpoints, and only with a token", async () => {
    const gateway = makeGateway({});
    const auth = { headers: { "x-api-key": LIVE } };
    expect((await gateway.call("/anthropic/v1/files", auth)).status).toBe(404);
    expect((await gateway.call("/openai/v1/embeddings", auth)).status).toBe(404);
    expect((await gateway.call("/v1/messages", auth)).status).toBe(404);
    expect((await gateway.call("/anthropic/v1/messages")).status).toBe(401);
    expect((await gateway.call("/anthropic/v1/models", auth)).status).toBe(200);
    expect(gateway.asked).toHaveLength(1);
  });

  it("says so when it has no key or cannot reach the thread", async () => {
    const auth = { headers: { "x-api-key": LIVE } };
    const keyless = makeGateway({ withoutKeys: true });
    expect((await keyless.call("/anthropic/v1/messages", auth)).status).toBe(503);
    const unreachable = makeGateway({
      authorize: () => Promise.reject(new Error("cloud down")),
    });
    expect((await unreachable.call("/anthropic/v1/messages", auth)).status).toBe(503);
    expect(unreachable.forwarded).toEqual([]);
  });

  it("records the model and token usage an Anthropic stream reports", async () => {
    const gateway = makeGateway({
      upstream: () =>
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5",',
          '"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":87}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
    });
    const response = await gateway.call("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LIVE },
      body: "{}",
    });
    expect(await response.text()).toContain("message_stop");
    expect(gateway.logs).toMatchObject([
      {
        outcome: "complete",
        runId,
        traceId,
        model: "claude-opus-5-5",
        usage: { input: 12, output: 87, cacheRead: 4000, cacheWrite: 300 },
      },
    ]);
  });

  it("records the model and token usage an OpenAI stream reports, cached input apart", async () => {
    const gateway = makeGateway({
      upstream: () =>
        sse([
          'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-6","usage":null}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-2026-09-01",',
          '"usage":{"input_tokens":1500,"input_tokens_details":{"cached_tokens":1200},"output_tokens":40}}}\n\n',
        ]),
    });
    const response = await gateway.call("/openai/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${LIVE}` },
      body: "{}",
    });
    await response.text();
    expect(gateway.logs).toMatchObject([
      {
        provider: "openai",
        traceId,
        model: "gpt-6-2026-09-01",
        usage: { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0 },
      },
    ]);
  });
});

/** An event stream sent in the given pieces, which need not end on line boundaries. */
const sse = (pieces: ReadonlyArray<string>) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );

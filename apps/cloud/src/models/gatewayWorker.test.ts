import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import type { ModelGatewayRecord } from "./ModelRecords.ts";
import type { ModelServeReply } from "./ModelProtocol.ts";

vi.mock("../../evlog.config.ts", async () => {
  const { defineEvlog } = await import("evlog");
  return { drain: undefined, default: defineEvlog({ silent: true }) };
});

import GatewayWorker, { type ModelGatewayEnv } from "./gatewayWorker.ts";

const LIVE = "sbm1.dGhyZWFkLWE.live";
const LOCAL = "sbk_live";
const runId = RunId.make("run-1");
const traceId = "trace-1";

const makeContext = () => {
  const waitUntil: Array<Promise<unknown>> = [];
  return {
    context: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntil.push(promise);
      },
    },
    waitUntil,
  };
};

describe("public model gateway worker", () => {
  it("streams the completed response before its background report resolves", async () => {
    let sendChunk: ((chunk: string) => void) | undefined;
    let closeStream: (() => void) | undefined;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sendChunk = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
          closeStream = () => controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const reports: Array<ModelGatewayRecord> = [];
    let finishReport: (() => void) | undefined;
    const reportPending = new Promise<void>((resolve) => {
      finishReport = resolve;
    });
    const env: ModelGatewayEnv = {
      GRANTS: {
        serve: async (): Promise<ModelServeReply> => ({
          _tag: "granted",
          runId,
          traceId,
          authMs: 1,
          reply: { _tag: "forwarded", response: upstream, upstreamMs: 1 },
        }),
        report: async (record) => {
          reports.push(record);
          return reportPending;
        },
      },
    };
    const ctx = makeContext();

    const response = await GatewayWorker.fetch(
      new Request("https://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": LIVE },
        body: "{}",
      }),
      env,
      ctx.context,
    );
    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a streamed response body");
    const firstRead = reader.read();
    sendChunk?.("event: message_start\n\n");
    expect(new TextDecoder().decode((await firstRead).value)).toBe("event: message_start\n\n");
    expect(reports).toEqual([]);

    const finalRead = reader.read();
    closeStream?.();
    expect((await finalRead).done).toBe(true);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      provider: "anthropic",
      status: 200,
      threadId: "thread-a",
      runId,
      traceId,
      outcome: "complete",
    });

    finishReport?.();
    await Promise.all(ctx.waitUntil);
  });

  it("reports usage from a completed local-key response to the key owner", async () => {
    const reports: Array<ModelGatewayRecord> = [];
    const env: ModelGatewayEnv = {
      GRANTS: {
        serve: async (): Promise<ModelServeReply> => ({
          _tag: "granted-local",
          userId: "user-1",
          keyId: "key-1",
          authMs: 1,
          reply: {
            _tag: "forwarded",
            response: new Response(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"model":"claude",',
                '"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
            upstreamMs: 1,
          },
        }),
        report: async (record) => {
          reports.push(record);
        },
      },
    };
    const ctx = makeContext();

    const response = await GatewayWorker.fetch(
      new Request("https://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-signalbox-key": LOCAL },
        body: "{}",
      }),
      env,
      ctx.context,
    );
    expect(response.status).toBe(200);
    expect(reports).toEqual([]);

    expect(await response.text()).toContain("message_stop");
    expect(reports).toMatchObject([
      {
        status: 200,
        threadId: null,
        runId: null,
        local: { userId: "user-1", keyId: "key-1" },
        outcome: "complete",
        model: "claude",
        usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    await Promise.all(ctx.waitUntil);
  });

  it("swallows a rejected report and never reports denied or unsuccessful local requests", async () => {
    const reports: Array<ModelGatewayRecord> = [];
    const env: ModelGatewayEnv = {
      GRANTS: {
        serve: async (token): Promise<ModelServeReply> => {
          if (token === LOCAL) {
            return {
              _tag: "granted-local",
              userId: "user-1",
              keyId: "key-1",
              authMs: 1,
              reply: {
                _tag: "forwarded",
                response: new Response("pool failed", { status: 503 }),
                upstreamMs: 1,
              },
            };
          }
          return { _tag: "denied", reason: "ended", authMs: 1 };
        },
        report: async (record) => {
          reports.push(record);
          throw new Error("report service unavailable");
        },
      },
    };
    const ctx = makeContext();

    const denied = await GatewayWorker.fetch(
      new Request("https://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": LIVE },
        body: "{}",
      }),
      env,
      ctx.context,
    );
    expect(denied.status).toBe(401);
    await denied.text();

    const failedLocal = await GatewayWorker.fetch(
      new Request("https://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-signalbox-key": LOCAL },
        body: "{}",
      }),
      env,
      ctx.context,
    );
    expect(failedLocal.status).toBe(503);
    await failedLocal.text();

    expect(reports).toEqual([]);
    await Promise.all(ctx.waitUntil);

    const rejectedReports: Array<ModelGatewayRecord> = [];
    const reportEnv: ModelGatewayEnv = {
      GRANTS: {
        serve: async (): Promise<ModelServeReply> => ({
          _tag: "granted",
          runId,
          traceId,
          authMs: 1,
          reply: { _tag: "forwarded", response: new Response("ok"), upstreamMs: 1 },
        }),
        report: async (record) => {
          rejectedReports.push(record);
          throw new Error("report service unavailable");
        },
      },
    };
    const reportContext = makeContext();
    const response = await GatewayWorker.fetch(
      new Request("https://gateway.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": LIVE },
        body: "{}",
      }),
      reportEnv,
      reportContext.context,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(rejectedReports).toMatchObject([{ outcome: "complete", runId }]);
    await expect(Promise.all(reportContext.waitUntil)).resolves.toBeDefined();
  });
});

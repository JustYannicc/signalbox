import { describe, expect, it, vi } from "vite-plus/test";
import type { ClaudeAttemptResources } from "./claudeAttemptCounters.ts";
import { createClaudeWorkloadTransport } from "./claudeModelTransport.ts";
import { CLAUDE_QUALIFICATION_API_REVISION } from "./claudeConfiguration.ts";

describe("Claude qualification workload transport", () => {
  it("records the collector nonce and API revision while forwarding the untouched request", async () => {
    const records: unknown[] = [];
    const wires: Uint8Array[] = [];
    let resources: ClaudeAttemptResources | undefined;
    const fetch = vi.fn(async () =>
      Response.json(
        { id: "msg_qualification", type: "message" },
        {
          headers: { "request-id": "req_qualification" },
        },
      ),
    );
    const transport = createClaudeWorkloadTransport({
      collectorNonce: "collector-nonce-1",
      apiRevision: CLAUDE_QUALIFICATION_API_REVISION,
      fetch,
      record: async (record, wire) => {
        records.push(record);
        if (wire) wires.push(wire);
      },
    });
    const request = new Request("https://model.invalid/v1/messages?stream=0", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "Reply with the controlled fixture text." }],
      }),
    });
    const response = await transport(request, (snapshot) => {
      resources = snapshot;
    });

    expect(fetch).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "msg_qualification" });
    expect(records).toMatchObject([
      {
        purpose: "qualification",
        apiRevision: "EC1APIr2",
        collectorNonce: "collector-nonce-1",
        ordinal: 1,
        phase: "request",
        method: "POST",
        path: "/v1/messages?stream=0",
        model: "claude-sonnet-4-6",
        stream: false,
      },
      {
        purpose: "qualification",
        apiRevision: "EC1APIr2",
        collectorNonce: "collector-nonce-1",
        ordinal: 1,
        phase: "response",
        status: 200,
        requestId: "req_qualification",
      },
    ]);
    expect(wires).toHaveLength(2);
    expect(new TextDecoder().decode(wires[0])).toBe(await request.clone().text());
    expect(JSON.parse(new TextDecoder().decode(wires[1]))).toMatchObject({
      id: "msg_qualification",
    });
    expect((records[1] as { wireBytes: number }).wireBytes).toBe(wires[1]!.byteLength);
    expect(await request.clone().json()).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(resources).toMatchObject({
      transportEntered: true,
      requestCaptureBytes: wires[0]!.byteLength,
      responseCaptureBytes: wires[1]!.byteLength,
      activeBufferedBytes: 0,
      peakBufferedBytes: wires[0]!.byteLength + wires[1]!.byteLength,
      cumulativeBufferedBytes: wires[0]!.byteLength + wires[1]!.byteLength,
      requestCaptureBodyLifecycle: "consumed",
      responseCaptureBodyLifecycle: "consumed",
      incomingRequestBodyLifecycle: "delegated-unverified",
      returnedResponseBodyLifecycle: "caller-owned",
    });
  });

  it("fails closed outside the Messages API", async () => {
    const fetch = vi.fn(async () => new Response("unexpected"));
    const transport = createClaudeWorkloadTransport({
      collectorNonce: "collector-nonce-1",
      apiRevision: CLAUDE_QUALIFICATION_API_REVISION,
      fetch,
      record: async () => {},
    });

    await expect(
      transport(new Request("https://model.invalid/v1/models", { method: "POST", body: "{}" })),
    ).rejects.toThrow("Claude qualification only admits Messages API requests");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears captured request bytes once and preserves a peer failure", async () => {
    const failure = new Error("fixture peer failed");
    const phases: string[] = [];
    const observed: ClaudeAttemptResources[] = [];
    const transport = createClaudeWorkloadTransport({
      collectorNonce: "collector-nonce-1",
      apiRevision: CLAUDE_QUALIFICATION_API_REVISION,
      fetch: async () => {
        throw failure;
      },
      record: async (record) => {
        phases.push(record.phase);
      },
    });
    const request = new Request("https://model.invalid/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user" }] }),
    });

    await expect(
      transport(request, (resources) => {
        observed.push(resources);
      }),
    ).rejects.toBe(failure);

    expect(phases).toEqual(["request", "failure"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      requestCaptureBodyLifecycle: "consumed",
      responseCaptureBodyLifecycle: "not-read",
      returnedResponseBodyLifecycle: "none",
      activeBufferedBytes: 0,
      peakBufferedBytes: observed[0]!.requestCaptureBytes,
      cumulativeBufferedBytes: observed[0]!.requestCaptureBytes,
    });
  });

  it("cancels an unreturned response after evidence persistence fails", async () => {
    const failure = new Error("response evidence write failed");
    const phases: string[] = [];
    const observed: ClaudeAttemptResources[] = [];
    const response = new Response("streamed fixture response");
    const transport = createClaudeWorkloadTransport({
      collectorNonce: "collector-nonce-1",
      apiRevision: CLAUDE_QUALIFICATION_API_REVISION,
      fetch: async () => response,
      record: async (record) => {
        phases.push(record.phase);
        if (record.phase === "response") throw failure;
      },
    });
    const request = new Request("https://model.invalid/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user" }] }),
    });

    await expect(
      transport(request, (resources) => {
        observed.push(resources);
      }),
    ).rejects.toBe(failure);

    expect(phases).toEqual(["request", "response", "failure"]);
    expect(response.bodyUsed).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      responseCaptureBodyLifecycle: "consumed",
      returnedResponseBodyLifecycle: "cancelled",
      activeBufferedBytes: 0,
      cumulativeBufferedBytes: observed[0]!.requestCaptureBytes + observed[0]!.responseCaptureBytes,
    });
  });
});

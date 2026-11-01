import { BlobJournal } from "./blobJournal.ts";
import { expect, it } from "vite-plus/test";
import { CLAUDE_MODEL_GATEWAY_BASE_URL } from "../../../../src/harness/ClaudeGatewayAccess.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";
import { ClaudeController } from "./claudeController.ts";
import { CLAUDE_QUALIFICATION_API_REVISION } from "./claudeConfiguration.ts";

it("retains the actual body cleanup error when an attempt marker fails", async () => {
  const markerFailure = new Error("attempt marker failed");
  const storage = {
    transaction: async () => {
      throw markerFailure;
    },
  } as unknown as DurableObjectStorage;
  const controller = new ClaudeController({} as QualifierExecutionContext, storage);
  const request = new Request("https://model.invalid/v1/messages", { method: "POST", body: "{}" });
  const reader = request.body!.getReader();
  try {
    await expect(controller.request(request)).rejects.toMatchObject({
      cause: markerFailure,
      errors: [markerFailure, expect.any(TypeError)],
    });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});

it("finalizes controller attempts and records retries rejected before wire transport", async () => {
  const values = new Map<string, unknown>([
    ["claude/active-step", { variant: "baseline", requestId: "request-1", phase: "work" }],
    [
      "claude/gateway/baseline",
      { baseUrl: CLAUDE_MODEL_GATEWAY_BASE_URL, credentialRef: "sbq1.synthetic-credential" },
    ],
  ]);
  const read = async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined;
  const write = async (key: string, value: unknown) => {
    values.set(key, value);
  };
  const transaction = async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
    await callback({ get: read, put: write, delete: async (key: string) => values.delete(key) });
  const storage = {
    get: read,
    put: write,
    transaction,
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...values.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, value as T]),
      ),
  } as unknown as DurableObjectStorage;
  const wirePhases: string[] = [];
  let sequence = 0;
  const configuration = {
    runId: "claude-attempt-test",
    claude: {
      runtime: {
        workload: {
          collectorNonce: "collector-nonce-controller-test",
          apiRevision: CLAUDE_QUALIFICATION_API_REVISION,
          model: "claude-sonnet-4-6",
        },
      },
    },
  } as Awaited<ReturnType<QualifierExecutionContext["config"]>>;
  const owner = {
    config: async () => configuration,
    append: async (type: string, value: unknown) => {
      if (type === "claude-model-wire") wirePhases.push((value as { phase: string }).phase);
      return { sequence: ++sequence };
    },
    artifact: async (name: string, bytes: Uint8Array) => {
      return { artifactRef: name, bytes: bytes.byteLength, sha256: "a".repeat(64) };
    },
  } as unknown as QualifierExecutionContext;
  const controller = new ClaudeController(owner, storage);
  const request = (model: string) =>
    new Request(`${CLAUDE_MODEL_GATEWAY_BASE_URL}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        authorization: "Bearer sbq1.synthetic-credential",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model }),
    });

  const response = await controller.request(request("claude-sonnet-4-6"));
  expect(await response.json()).toMatchObject({ input_tokens: expect.any(Number) });

  await expect(controller.request(request("wrong-model"))).rejects.toThrow(
    "Claude Messages request identity or conversation is invalid",
  );
  for (let retry = 0; retry < 2; retry++) {
    await expect(controller.request(request("claude-sonnet-4-6"))).rejects.toThrow(
      "Claude model's first failure forbids another request",
    );
  }

  const counters = await controller.requestAttemptCounters();
  expect(counters).toMatchObject({
    started: 4,
    activeRequests: 0,
    succeeded: 1,
    failed: 3,
    finalized: 4,
    transportEntered: 2,
    requestCaptureBytes: expect.any(Number),
    responseCaptureBytes: expect.any(Number),
  });
  expect(
    counters.incomingRequestBodiesCancelled + counters.incomingRequestBodiesCancelRequested,
  ).toBe(3);
  const attempts = await controller.requestAttempts();
  expect(attempts).toMatchObject([
    {
      ordinal: 1,
      state: "finished",
      outcome: "success",
      finalized: true,
      resources: {
        activeBufferedBytes: 0,
        requestCaptureBodyLifecycle: "consumed",
        responseCaptureBodyLifecycle: "consumed",
        returnedResponseBodyLifecycle: "caller-owned",
      },
    },
    {
      ordinal: 2,
      state: "finished",
      outcome: "failure",
      failedAt: "transport",
      finalized: true,
      resources: {
        activeBufferedBytes: 0,
        requestCaptureBodyLifecycle: "consumed",
        responseCaptureBodyLifecycle: "not-read",
      },
    },
    {
      ordinal: 3,
      state: "finished",
      outcome: "failure",
      failedAt: "first-failure",
      finalized: true,
      resources: {
        transportEntered: false,
        activeBufferedBytes: 0,
        requestCaptureBytes: 0,
        responseCaptureBytes: 0,
        incomingRequestBodyLifecycle: expect.stringMatching(/^(cancelled|cancel-requested)$/u),
      },
    },
    {
      ordinal: 4,
      state: "finished",
      outcome: "failure",
      failedAt: "first-failure",
      finalized: true,
      resources: {
        transportEntered: false,
        activeBufferedBytes: 0,
        requestCaptureBytes: 0,
        responseCaptureBytes: 0,
        incomingRequestBodyLifecycle: expect.stringMatching(/^(cancelled|cancel-requested)$/u),
      },
    },
  ]);
  for (const attempt of attempts) {
    expect(attempt.rpc).toMatchObject({
      scope: "cloud-rpc-module-global",
      start: { memoryMeasurement: "unavailable", heapBytes: null, rssBytes: null },
      end: { memoryMeasurement: "unavailable", heapBytes: null, rssBytes: null },
    });
  }
  const exported = await new BlobJournal(storage).page("claude/");
  expect(
    exported.entries.filter(([key]) => key.startsWith("claude/request-attempt/")),
  ).toHaveLength(4);
  expect(
    exported.entries.find(([key]) => key === "claude/request-attempt-counters")?.[1],
  ).toMatchObject({ started: 4, finalized: 4, activeRequests: 0 });
  expect(wirePhases).toEqual(["request", "response", "request", "failure"]);
});

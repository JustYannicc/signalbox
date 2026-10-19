import { describe, expect, it, vi } from "vite-plus/test";
import {
  runCodeModeHostConnection,
  type CodeModeCellCode,
  type CodeModeCellEvents,
  type CodeModeCellCompletion,
} from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { hostClient } from "./client.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const code: CodeModeCellCode = { mainModule: "unused.js", modules: {} };
const loader = {
  run: async (): Promise<never> => {
    throw new Error("Unexpected cell execution");
  },
};

describe("CodeMode framed protocol admission", () => {
  it("refuses a full shared capacity before sending execution started", async () => {
    const entered = Promise.withResolvers<CodeModeCellEvents>();
    const completion = Promise.withResolvers<CodeModeCellCompletion>();
    const capacity = new ChildWorkerCapacity(1);
    const client = hostClient(
      {
        run: async (_input, events) => {
          entered.resolve(events);
          return completion.promise;
        },
      },
      code,
      capacity,
    );
    await client.hello();
    await client.open();
    const request = {
      method: "session/execute",
      sessionId: "s1",
      request: {
        source: "",
        tool_call_id: "admission",
        enabled_tools: [],
        yield_time_ms: 0,
        max_output_tokens: null,
      },
    };
    await client.request(request).response;
    const events = await entered.promise;
    try {
      expect(await client.request(request).response).toEqual({
        type: "operation/response",
        id: 3,
        result: { status: "error", message: "code-mode host has too many active cells" },
      });
      expect(capacity.active).toBe(1);
    } finally {
      await events.stopped();
      completion.resolve({ terminated: false, error: null, writes: {} });
      await client.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("rejects oversized frame headers before reading or allocating their payload", async () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 64 * 1024 * 1024 + 1, true);
    await expect(fromBytes(header)).rejects.toThrow("frame exceeds 64 MiB");
  });

  it("rejects truncated binary input and invalid UTF-8", async () => {
    await expect(fromBytes(Uint8Array.of(1, 0))).rejects.toThrow("Truncated");
    await expect(fromBytes(Uint8Array.of(2, 0, 0, 0, 123))).rejects.toThrow("Truncated");
    await expect(fromBytes(Uint8Array.of(1, 0, 0, 0, 255))).rejects.toThrow();
  });

  it("rejects duplicate operation IDs across the shared host connection", async () => {
    const client = hostClient(loader, code);
    await client.hello();
    const opening = client.request({ method: "session/open", sessionId: "first" });
    await opening.response;
    client.send({
      type: "operation/request",
      id: opening.id,
      request: { method: "session/open", sessionId: "other" },
    });
    await expect(client.finished).rejects.toThrow("Duplicate CodeMode request ID");
  });

  it("rejects custom heap limits and prevents session identity reuse", async () => {
    const client = hostClient(loader, code);
    await client.hello();
    expect(
      await client.request({
        method: "session/open",
        sessionId: "limited",
        cellExecutionLimits: { maxHeapSizeBytes: 1024 },
      }).response,
    ).toMatchObject({
      result: { status: "error", message: expect.stringContaining("not supported") },
    });
    await client.open();
    await client.request({ method: "session/shutdown", sessionId: "s1" }).response;
    expect(await client.open()).toMatchObject({
      result: { status: "error", message: expect.stringContaining("reused") },
    });
    await client.close();
  });
});

function fromBytes(bytes: Uint8Array) {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return runCodeModeHostConnection({
    input,
    output: new WritableStream<Uint8Array>(),
    signal: new AbortController().signal,
    loader,
    code,
    capacity: new ChildWorkerCapacity(1),
  });
}

import { describe, expect, it, vi } from "vite-plus/test";
import type { CodeModeCellCode, CodeModeCellEvents } from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { hostClient } from "./client.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const code: CodeModeCellCode = { mainModule: "unused.js", modules: {} };

describe("CodeMode queued cell admission", () => {
  it("lets an observer yield and wait while the cell has no permit", async () => {
    const fixture = await queuedFixture();
    try {
      const call = fixture.client.request(executeRequest(0));
      expect(await call.response).toMatchObject({
        result: { status: "ok", value: { type: "execution/started", cellId: "1" } },
      });
      expect(
        await fixture.client.receive(
          (message) => message.type === "execute/initialResponse" && message.id === call.id,
        ),
      ).toMatchObject({ result: { value: { Yielded: { cell_id: "1" } } } });
      expect(await fixture.client.wait("1", 0).response).toMatchObject({
        result: {
          value: {
            type: "wait/completed",
            outcome: { LiveCell: { Yielded: { cell_id: "1" } } },
          },
        },
      });

      await fixture.release();
      expect(await fixture.client.wait("1").response).toMatchObject({
        result: { value: { outcome: { LiveCell: { Result: { cell_id: "1" } } } } },
      });
    } finally {
      await fixture.close();
    }
    expect(fixture.capacity.active).toBe(0);
  });

  it("accepts operation/yield while a cell is queued", async () => {
    const fixture = await queuedFixture();
    try {
      const call = fixture.client.request(executeRequest(60_000));
      expect(await call.response).toMatchObject({
        result: { status: "ok", value: { type: "execution/started", cellId: "1" } },
      });
      fixture.client.send({ type: "operation/yield", id: call.id });
      expect(
        await fixture.client.receive(
          (message) => message.type === "execute/initialResponse" && message.id === call.id,
        ),
      ).toMatchObject({ result: { value: { Yielded: { cell_id: "1" } } } });

      await fixture.release();
      expect(await fixture.client.wait("1").response).toMatchObject({
        result: { value: { outcome: { LiveCell: { Result: { cell_id: "1" } } } } },
      });
    } finally {
      await fixture.close();
    }
    expect(fixture.capacity.active).toBe(0);
  });
});

function executeRequest(yield_time_ms: number) {
  return {
    method: "session/execute",
    sessionId: "s1",
    request: {
      source: "",
      tool_call_id: "queued",
      enabled_tools: [],
      yield_time_ms,
      max_output_tokens: null,
    },
  };
}

async function queuedFixture() {
  const capacity = new ChildWorkerCapacity(1, {
    owner: "test/src-harness-codemode-tests-codemodequeuedadmission-test-1",
  });
  const held = await capacity.acquire(new AbortController().signal, undefined);
  const entered = Promise.withResolvers<CodeModeCellEvents>();
  const completion = Promise.withResolvers<void>();
  const client = hostClient(
    {
      run: async (_input, events) => {
        entered.resolve(events);
        await completion.promise;
        await events.stopped();
        return { terminated: false, error: null, writes: {} };
      },
    },
    code,
    capacity,
  );
  await client.hello();
  await client.open();
  return {
    client,
    capacity,
    async release() {
      held.release();
      const events = await entered.promise;
      events.stopped();
      completion.resolve();
    },
    async close() {
      held.release();
      completion.resolve();
      await client.close();
    },
  };
}

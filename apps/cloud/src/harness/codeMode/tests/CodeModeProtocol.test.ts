import { describe, expect, it, vi } from "vite-plus/test";
import {
  runCodeModeHostConnection,
  type CodeModeCellCode,
  type CodeModeCellEvents,
  type CodeModeCellCompletion,
} from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { kernelOk } from "../../../kernel/KernelAbi.ts";
import { KernelProcessTable, type KernelExitStatus } from "../../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { hostClient } from "./client.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const code: CodeModeCellCode = { mainModule: "unused.js", modules: {} };
const loader = {
  run: async (): Promise<never> => {
    throw new Error("Unexpected cell execution");
  },
};

describe("CodeMode framed protocol admission", () => {
  it("queues a full cell pool until a cell stops", async () => {
    const entered = Promise.withResolvers<CodeModeCellEvents>();
    const nextEntered = Promise.withResolvers<CodeModeCellEvents>();
    const nextCompletion = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<CodeModeCellCompletion>();
    const capacity = new ChildWorkerCapacity(1);
    let runs = 0;
    const client = hostClient(
      {
        run: async (_input, events) => {
          if (++runs === 1) {
            entered.resolve(events);
            return completion.promise;
          }
          nextEntered.resolve(events);
          await nextCompletion.promise;
          await events.stopped();
          return { terminated: false, error: null, writes: {} };
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
    const queued = Promise.withResolvers<void>();
    const acquire = capacity.acquire.bind(capacity);
    try {
      const first = client.request(request);
      await first.response;
      await client.receive(
        (message) => message.type === "execute/initialResponse" && message.id === first.id,
      );
      const events = await entered.promise;
      vi.spyOn(capacity, "acquire").mockImplementation((...args) => {
        const pending = acquire(...args);
        queued.resolve();
        return pending;
      });
      const next = client.request(request);
      await queued.promise;
      expect(runs).toBe(1);
      expect(capacity.active).toBe(1);
      expect(await next.response).toMatchObject({
        result: { status: "ok", value: { type: "execution/started", cellId: "2" } },
      });
      expect(
        await client.receive(
          (message) => message.type === "execute/initialResponse" && message.id === next.id,
        ),
      ).toMatchObject({ result: { value: { Yielded: { cell_id: "2" } } } });
      await events.stopped();
      completion.resolve({ terminated: false, error: null, writes: {} });
      const nextEvents = await nextEntered.promise;
      nextEvents.stopped();
      nextCompletion.resolve();
      await client.wait("2").response;
      expect(runs).toBe(2);
    } finally {
      completion.resolve({ terminated: false, error: null, writes: {} });
      nextCompletion.resolve();
      await client.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("completes limit plus one cells that each wait for a command", async () => {
    const commands = new ChildWorkerCapacity();
    const cells = new ChildWorkerCapacity(commands.limit);
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const processDone = Promise.withResolvers<KernelExitStatus>();
    const processes = new KernelProcessTable({ wakes: new KernelWakeRegistry() });
    const spawned = processes.spawn(
      undefined,
      () => ({ completion: processDone.promise, signal: () => kernelOk(undefined) }),
      () => undefined,
    );
    if (spawned.status !== "ok") throw new Error("test requester process failed to spawn");
    const requester = { processes, process: spawned.value.handle };
    const signal = new AbortController().signal;
    let entered = 0;
    let completed = 0;
    const client = hostClient(
      {
        async run(_input, events) {
          await commands.run(
            signal,
            async () => {
              if (++entered === commands.limit) ready.resolve();
              await finish.promise;
              completed++;
            },
            requester,
          );
          await events.stopped();
          return { terminated: false, error: null, writes: {} };
        },
      },
      code,
      cells,
    );
    try {
      await client.hello();
      await client.open();
      const results = Array.from({ length: commands.limit + 1 }, () => client.execute(""));
      await ready.promise;
      expect(cells.active).toBe(cells.limit);
      expect(commands.active).toBe(commands.limit);
      finish.resolve();
      for (const result of await Promise.all(results)) {
        expect(result).toMatchObject({
          result: { status: "ok", value: { Result: { error_text: null } } },
        });
      }
      expect(completed).toBe(commands.limit + 1);
    } finally {
      finish.resolve();
      processDone.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await client.close();
      await processes.dispose();
    }
    expect(cells.active).toBe(0);
    expect(commands.active).toBe(0);
  });

  it.each(["cancel", "shutdown", "disconnect"])("cancels queued cells on %s", async (action) => {
    const capacity = new ChildWorkerCapacity(1);
    const held = await capacity.acquire(new AbortController().signal);
    const queued = Promise.withResolvers<void>();
    const acquire = capacity.acquire.bind(capacity);
    vi.spyOn(capacity, "acquire").mockImplementation((...args) => {
      const pending = acquire(...args);
      queued.resolve();
      return pending;
    });
    const run = vi.fn(loader.run);
    const client = hostClient({ run }, code, capacity);
    try {
      await client.hello();
      await client.open();
      const pending = client.request({
        method: "session/execute",
        sessionId: "s1",
        request: {
          source: "",
          tool_call_id: "queued",
          enabled_tools: [],
          yield_time_ms: 0,
          max_output_tokens: null,
        },
      });
      await queued.promise;
      expect(await pending.response).toMatchObject({
        result: { status: "ok", value: { type: "execution/started", cellId: "1" } },
      });
      if (action === "cancel") client.send({ type: "operation/cancel", id: pending.id });
      else if (action === "shutdown")
        await client.request({ method: "session/shutdown", sessionId: "s1" }).response;
      else await client.abort();
      if (action !== "disconnect") {
        expect(
          await client.receive(
            (message) => message.type === "execute/initialResponse" && message.id === pending.id,
          ),
        ).toMatchObject({ result: { status: "ok", value: { Terminated: { cell_id: "1" } } } });
      }
      held.release();
      expect(run).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      held.release();
      if (action === "disconnect") await client.abort();
      else await client.close();
    }
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
    cellCapacity: new ChildWorkerCapacity(1),
  });
}

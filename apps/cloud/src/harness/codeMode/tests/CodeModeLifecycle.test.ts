import { expect, it, vi } from "vite-plus/test";
import type { CodeModeLifecycleEvent } from "../../CodeModeHost.ts";
import type { CodeModeCellEvents, CodeModeCellLoaderPort } from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { hostClient } from "./client.ts";
import { createCodeModeWorkerLoader } from "../../../codeMode/Loader.ts";
import { vmWorkerLoader } from "../../../codeMode/workerTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const identity = { sessionId: "s1", cellId: "1", tool_call_id: "outer-exec-call" };
const completed = { terminated: false, error: null, writes: {} };

it("reports started and completed only after physical stop and permit cleanup", async () => {
  const returned = Promise.withResolvers<void>();
  const events = Promise.withResolvers<CodeModeCellEvents>();
  const fixture = await lifecycleFixture({
    async run(_input, callbacks) {
      await callbacks.started();
      events.resolve(callbacks);
      returned.resolve();
      return completed;
    },
  });
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id, yield_time_ms: 0 });
    await returned.promise;
    expect(fixture.events).toEqual([{ ...identity, type: "started" }]);
    expect(fixture.capacity.active).toBe(1);
    await (await events.promise).stopped();
    await fixture.closed;
    expect(fixture.events).toEqual([
      { ...identity, type: "started" },
      { ...identity, type: "closed", started: true, outcome: "completed", error: null },
    ]);
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await (await events.promise).stopped();
    await fixture.client.close();
  }
});

it.each(["terminate", "disconnect"] as const)(
  "reports one aborted closure after %s during execution",
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const fixture = await lifecycleFixture({
      async run(_input, events) {
        await events.started();
        entered.resolve();
        await events.cancelled();
        cancelled.resolve();
        await release.promise;
        await events.stopped();
        return { ...completed, terminated: true };
      },
    });
    try {
      await fixture.client.execute("", { tool_call_id: identity.tool_call_id, yield_time_ms: 0 });
      await entered.promise;
      const stopping =
        mode === "disconnect"
          ? fixture.client.abort()
          : fixture.client.request({ method: "session/terminate", sessionId: "s1", cellId: "1" })
              .response;
      await cancelled.promise;
      expect(fixture.events).toEqual([{ ...identity, type: "started" }]);
      release.resolve();
      await stopping;
      await fixture.closed;
      expect(fixture.events).toEqual([
        { ...identity, type: "started" },
        { ...identity, type: "closed", started: true, outcome: "aborted", error: null },
      ]);
      expect(fixture.capacity.active).toBe(0);
    } finally {
      release.resolve();
      if (mode !== "disconnect") await fixture.client.close();
    }
  },
);

it("reports queued cancellation without starting an execution", async () => {
  const run = vi.fn<CodeModeCellLoaderPort["run"]>();
  const capacity = cellCapacity();
  const held = await capacity.acquire(new AbortController().signal, undefined);
  const fixture = await lifecycleFixture({ run }, capacity);
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id, yield_time_ms: 0 });
    expect(fixture.events).toEqual([]);
    await fixture.client.request({ method: "session/terminate", sessionId: "s1", cellId: "1" })
      .response;
    await fixture.closed;
    expect(fixture.events).toEqual([{ ...identity, type: "queued-cancel" }]);
    expect(run).not.toHaveBeenCalled();
  } finally {
    await held.release();
    await fixture.client.close();
  }
});

it("reports acquisition failure without starting an execution", async () => {
  const capacity = cellCapacity();
  const acquire = vi.spyOn(capacity, "acquire").mockRejectedValue(new Error("admission failed"));
  const run = vi.fn<CodeModeCellLoaderPort["run"]>();
  const fixture = await lifecycleFixture({ run }, capacity);
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id });
    await fixture.closed;
    expect(fixture.events).toEqual([
      { ...identity, type: "closed", started: false, outcome: "error", error: "admission failed" },
    ]);
    expect(run).not.toHaveBeenCalled();
  } finally {
    acquire.mockRestore();
    await fixture.client.close();
  }
});

it("does not report an execution when WorkerLoader acquisition fails", async () => {
  const workers = vmWorkerLoader();
  vi.spyOn(workers.loader, "get").mockImplementation(() => {
    throw new Error("worker acquisition failed");
  });
  const fixture = await lifecycleFixture(
    createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }),
  );
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id });
    await fixture.closed;
    expect(fixture.events).toEqual([
      {
        ...identity,
        type: "closed",
        started: false,
        outcome: "error",
        error: "worker acquisition failed",
      },
    ]);
    expect(fixture.capacity.active).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await fixture.client.close();
  }
});

it("reports worker errors after stopped acknowledgement", async () => {
  const fixture = await lifecycleFixture({
    async run(_input, events) {
      await events.started();
      await events.stopped();
      throw new Error("worker cleanup failed");
    },
  });
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id });
    await fixture.closed;
    expect(fixture.events).toEqual([
      { ...identity, type: "started" },
      {
        ...identity,
        type: "closed",
        started: true,
        outcome: "error",
        error: "worker cleanup failed",
      },
    ]);
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.client.close();
  }
});

it("reports permit cleanup failure as an error after physical stopping", async () => {
  const capacity = cellCapacity();
  const acquire = capacity.acquire.bind(capacity);
  vi.spyOn(capacity, "acquire").mockImplementation(async (signal, requester, request) => {
    const permit = await acquire(signal, requester, request);
    return {
      ...permit,
      async release() {
        await permit.release();
        throw new Error("permit cleanup failed");
      },
    };
  });
  const fixture = await lifecycleFixture(
    {
      async run(_input, events) {
        await events.started();
        await events.stopped();
        return completed;
      },
    },
    capacity,
  );
  try {
    await fixture.client.execute("", { tool_call_id: identity.tool_call_id });
    await fixture.closed;
    expect(fixture.events).toEqual([
      { ...identity, type: "started" },
      {
        ...identity,
        type: "closed",
        started: true,
        outcome: "error",
        error: "permit cleanup failed",
      },
    ]);
    expect(capacity.active).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await fixture.client.close();
  }
});

it("does not let an observer failure skip execution or cleanup", async () => {
  const run = vi.fn<CodeModeCellLoaderPort["run"]>(async (_input, events) => {
    await events.started();
    await events.stopped();
    return completed;
  });
  const fixture = await lifecycleFixture({ run }, cellCapacity(), (event) => {
    if (event.type === "started") throw new Error("observer failed");
  });
  try {
    const response = await fixture.client.execute("", { tool_call_id: identity.tool_call_id });
    await fixture.closed;
    expect(run).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([
      { ...identity, type: "started" },
      { ...identity, type: "closed", started: true, outcome: "error", error: "observer failed" },
    ]);
    expect(JSON.stringify(response)).toContain("CodeMode lifecycle observer failed");
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.client.close();
  }
});

function cellCapacity() {
  return new ChildWorkerCapacity(1, {
    owner: "test/code-mode-lifecycle",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
}

async function lifecycleFixture(
  loader: CodeModeCellLoaderPort,
  capacity = cellCapacity(),
  observer?: (event: CodeModeLifecycleEvent) => void,
) {
  const events: CodeModeLifecycleEvent[] = [];
  const terminal = Promise.withResolvers<void>();
  const client = hostClient(loader, { mainModule: "unused.js", modules: {} }, capacity, (event) => {
    events.push(event);
    if (event.type !== "started") terminal.resolve();
    observer?.(event);
  });
  await client.hello();
  await client.open();
  return { client, capacity, events, closed: terminal.promise };
}

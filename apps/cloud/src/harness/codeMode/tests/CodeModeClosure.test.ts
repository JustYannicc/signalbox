import { expect, it, vi } from "vite-plus/test";
import type { CodeModeCellEvents, CodeModeLifecycleEvent } from "../../CodeModeHost.ts";
import {
  createCodeModeWorkerLoader,
  createCodeModeServiceLoader,
} from "../../../codeMode/Loader.ts";
import { vmWorkerLoader } from "../../../codeMode/workerTesting.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { hostClient } from "./client.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const code = { mainModule: "unused.js", modules: {} };
const completion = { terminated: false, error: null, writes: {} };

it.each(["worker", "static"] as const)(
  "closes a crashed %s bridge and drains its permit",
  async (route) => {
    const workers = vmWorkerLoader();
    const worker = workers.loader.get(null, () => ({ ...code, compatibilityDate: "2026-10-19" }));
    const disposed: string[] = [];
    const entrypoint = {
      async run(_input: unknown, events: CodeModeCellEvents) {
        await events.started();
        throw new Error("worker RPC crashed");
      },
      [Symbol.dispose]() {
        disposed.push("entrypoint");
      },
    };
    Object.defineProperty(worker, "getEntrypoint", { value: () => entrypoint });
    Object.defineProperty(worker, Symbol.dispose, { value: () => disposed.push("worker") });
    vi.spyOn(workers.loader, "get").mockReturnValue(worker);
    const loader =
      route === "worker"
        ? createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } })
        : createCodeModeServiceLoader({ run: entrypoint.run });
    const callbacks = Promise.withResolvers<CodeModeCellEvents>();
    const returned = Promise.withResolvers<void>();
    const capacity = cellCapacity();
    const lifecycle: CodeModeLifecycleEvent[] = [];
    let stopCount = 0;
    const client = hostClient(
      {
        async run(input, events) {
          callbacks.resolve(events);
          try {
            return await loader.run(input, {
              ...events,
              async stopped() {
                stopCount++;
                expect(disposed).toEqual(route === "worker" ? ["entrypoint", "worker"] : []);
                await events.stopped();
              },
            });
          } finally {
            returned.resolve();
          }
        },
      },
      code,
      capacity,
      (event) => lifecycle.push(event),
    );
    await client.hello();
    await client.open();
    try {
      await client.execute("", { tool_call_id: "outer-crash", yield_time_ms: 0 });
      await returned.promise;
      expect(stopCount).toBe(1);
      await client.close();
      expect(capacity.active).toBe(0);
      expect(lifecycle).toEqual([
        { type: "started", sessionId: "s1", cellId: "1", tool_call_id: "outer-crash" },
        {
          type: "closed",
          sessionId: "s1",
          cellId: "1",
          tool_call_id: "outer-crash",
          started: true,
          outcome: "error",
          error: "worker RPC crashed",
        },
      ]);
    } finally {
      // Recover only this test's stalled owner when running the regression against the old bridge.
      if (stopCount === 0) await (await callbacks.promise).stopped();
      vi.restoreAllMocks();
      await client.abort();
    }
  },
);

it.each(["result", "error"] as const)(
  "withholds %s until stop, permit cleanup and terminal observation finish",
  async (mode) => {
    const callbacks = Promise.withResolvers<CodeModeCellEvents>();
    const returned = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const order: string[] = [];
    const capacity = cellCapacity();
    const acquire = capacity.acquire.bind(capacity);
    vi.spyOn(capacity, "acquire").mockImplementation(async (signal, requester, request) => {
      const permit = await acquire(signal, requester, request);
      return {
        ...permit,
        async release() {
          releasing.resolve();
          await release.promise;
          await permit.release();
        },
      };
    });
    const client = hostClient(
      {
        async run(_input, events) {
          await events.started();
          callbacks.resolve(events);
          returned.resolve();
          if (mode === "error") throw new Error("worker failed");
          return completion;
        },
      },
      code,
      capacity,
      (event) => {
        order.push(event.type);
        if (event.type === "closed") closed.resolve();
      },
    );
    await client.hello();
    await client.open();
    try {
      const initial = await client.execute("", { yield_time_ms: 0 });
      await returned.promise;
      expect(JSON.stringify(initial)).toContain('"Yielded"');
      expect(order).toEqual(["started"]);
      expect(JSON.stringify(await client.wait("1", 0).response)).toContain('"Yielded"');
      await (await callbacks.promise).stopped();
      await releasing.promise;
      expect(capacity.active).toBe(1);
      expect(JSON.stringify(await client.wait("1", 0).response)).toContain('"Yielded"');
      expect(order).toEqual(["started"]);
      release.resolve();
      await closed.promise;
      const result = await client.wait("1").response;
      expect(JSON.stringify(result)).toContain('"Result"');
      if (mode === "error") expect(JSON.stringify(result)).toContain("worker failed");
      order.push("result");
      expect(order).toEqual(["started", "closed", "result"]);
      expect(capacity.active).toBe(0);
    } finally {
      release.resolve();
      await (await callbacks.promise).stopped();
      vi.restoreAllMocks();
      await client.close();
    }
  },
);

function cellCapacity() {
  return new ChildWorkerCapacity(1, {
    owner: "test/code-mode-closure",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
}

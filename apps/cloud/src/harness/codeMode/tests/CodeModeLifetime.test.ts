import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import {
  createCodeModeServiceLoader,
  createCodeModeWorkerLoader,
  type CodeModeCellCode,
  type CodeModeCellCompletion,
  type CodeModeCellEvents,
  type CodeModeCellLoaderPort,
} from "../../CodeModeHost.ts";
import { hostClient } from "./client.ts";
import { codeModeInvocation, vmWorkerLoader } from "./vmLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

describe("CodeMode cell ownership", () => {
  it.each([
    {
      cause: "cancellation",
      source: 'await tools.slow({}); text("after cancel");',
      terminated: true,
      error: null,
    },
    {
      cause: "timer error",
      source: 'setTimeout(() => { throw "timer failure"; }, 0); await tools.slow({});',
      terminated: false,
      error: "timer failure",
    },
    {
      cause: "timer exit",
      source: "setTimeout(() => exit(), 0); await tools.slow({});",
      terminated: false,
      error: null,
    },
  ])(
    "unwinds an awaited tool after $cause without its remote response",
    async ({ source, cause, terminated, error }) => {
      const worker = vmWorkerLoader();
      const loader = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 10 } });
      const invoked = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const events: CodeModeCellEvents = {
        emit: async () => undefined,
        invoke: () => {
          invoked.resolve();
          return new Promise(() => {});
        },
        notify: async () => undefined,
        cancelled: () => cancelled.promise,
        closeCallbacks: vi.fn(async () => undefined),
        stopped: vi.fn(async () => undefined),
      };
      const input = codeModeInvocation(code, source);
      const run = loader.run(
        {
          ...input,
          request: {
            ...input.request,
            enabled_tools: [
              {
                name: "slow",
                tool_name: { name: "slow", namespace: null },
                kind: "function",
                description: "",
                input_schema: null,
                output_schema: null,
              },
            ],
          },
        },
        events,
      );
      await invoked.promise;
      if (cause === "cancellation") cancelled.resolve();
      await expect(run).resolves.toMatchObject({ terminated, error });
      expect(events.stopped).toHaveBeenCalledOnce();
    },
  );

  it.each(["transport disappeared", "CPU budget exceeded"])(
    "keeps capacity after loader rejection '%s' until a positive stop acknowledgement",
    async (failure) => {
      const entered = Promise.withResolvers<CodeModeCellEvents>();
      const failed = Promise.withResolvers<CodeModeCellCompletion>();
      const loader: CodeModeCellLoaderPort = {
        run: async (_input, events) => {
          entered.resolve(events);
          return failed.promise;
        },
      };
      const client = hostClient(loader, code);
      await client.hello();
      await client.open();
      const running = client.execute('text("unreachable");');
      const events = await entered.promise;
      expect(client.capacity.active).toBe(1);
      failed.reject(new Error(failure));
      expect(await running).toMatchObject({
        result: { value: { Result: { error_text: failure } } },
      });
      expect(client.capacity.active).toBe(1);
      let closed = false;
      const closing = client.close().then(() => {
        closed = true;
      });
      await events.cancelled();
      expect(closed).toBe(false);
      expect(client.capacity.active).toBe(1);
      await events.stopped();
      await closing;
      expect(client.capacity.active).toBe(0);
    },
  );

  it("does not accept a successful loader return as a physical stop acknowledgement", async () => {
    const entered = Promise.withResolvers<CodeModeCellEvents>();
    const client = hostClient(
      {
        run: async (_input, events) => {
          entered.resolve(events);
          return { terminated: false, error: null, writes: {} };
        },
      },
      code,
    );
    await client.hello();
    await client.open();
    const running = client.execute("", { yield_time_ms: 0 });
    const events = await entered.promise;
    expect(await running).toMatchObject({ result: { value: { Yielded: { cell_id: "1" } } } });
    expect(client.capacity.active).toBe(1);
    await events.stopped();
    expect(await client.wait("1").response).toMatchObject({
      result: { value: { outcome: { LiveCell: { Result: { error_text: null } } } } },
    });
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("revokes unawaited delegates before publishing a natural completion", async () => {
    const worker = vmWorkerLoader();
    const client = hostClient(
      createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 75 } }),
      code,
    );
    await client.hello();
    await client.open();
    const running = client.execute('tools.slow({}); text("done");', {
      enabled_tools: [
        {
          name: "slow",
          tool_name: { name: "slow", namespace: "native" },
          description: "",
          kind: "function",
          input_schema: null,
          output_schema: null,
        },
      ],
    });
    const invoked = await client.receive((message) => message.type === "delegate/request");
    const cancel = await client.receive((message) => message.type === "delegate/cancel");
    expect(cancel.id).toBe(invoked.id);
    expect(await running).toMatchObject({
      result: { value: { Result: { content_items: [{ type: "input_text", text: "done" }] } } },
    });
    client.send({
      type: "delegate/response",
      id: invoked.id,
      result: { status: "ok", value: { type: "tool/result", result: "late" } },
    });
    await client.close();
  });

  it("preserves the trusted callback across a named static service bridge", async () => {
    const worker = vmWorkerLoader();
    const direct = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 25 } });
    const service: Parameters<typeof createCodeModeServiceLoader>[0] = {
      run: vi.fn((input, events) => direct.run(input, events)),
    };
    const client = hostClient(createCodeModeServiceLoader(service), code);
    await client.hello();
    await client.open();
    expect(await client.execute('text("named binding");')).toMatchObject({
      result: {
        value: { Result: { content_items: [{ type: "input_text", text: "named binding" }] } },
      },
    });
    expect(service.run).toHaveBeenCalledOnce();
    expect(worker.observations[0]?.cpuMs).toBe(25);
    await client.close();
  });

  it("requires an owner CPU policy and never starts workers for forbidden imports", async () => {
    const worker = vmWorkerLoader();
    expect(() =>
      createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 0 } }),
    ).toThrow("cpuMs");
    const events: CodeModeCellEvents = {
      emit: async () => undefined,
      invoke: async () => null,
      notify: async () => undefined,
      cancelled: () => new Promise(() => {}),
      closeCallbacks: vi.fn(async () => undefined),
      stopped: vi.fn(async () => undefined),
    };
    const loader = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 10 } });
    await expect(
      loader.run(codeModeInvocation(code, 'export * from "cloudflare:workers";'), events),
    ).rejects.toThrow("do not support imports");
    expect(worker.observations).toHaveLength(0);
    expect(events.stopped).toHaveBeenCalledOnce();
  });

  it("attempts stop acknowledgement after callback cleanup fails", async () => {
    const worker = vmWorkerLoader();
    const loader = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 10 } });
    const order: string[] = [];
    const events: CodeModeCellEvents = {
      emit: async () => undefined,
      invoke: async () => null,
      notify: async () => undefined,
      cancelled: () => new Promise(() => {}),
      closeCallbacks: async () => {
        order.push("callbacks");
        throw new Error("callback cleanup failed");
      },
      stopped: async () => {
        order.push("stopped");
      },
    };
    await expect(loader.run(codeModeInvocation(code, 'text("done");'), events)).rejects.toThrow(
      "callback cleanup failed",
    );
    expect(order).toEqual(["callbacks", "stopped"]);
  });

  it("keeps cancelled timer-await capacity because clearing its callback cannot settle the guest promise", async () => {
    const worker = vmWorkerLoader();
    const direct = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 10 } });
    const callbacksClosed = Promise.withResolvers<void>();
    const client = hostClient(
      {
        run: (input, events) =>
          direct.run(input, {
            ...events,
            closeCallbacks: async () => {
              await events.closeCallbacks();
              callbacksClosed.resolve();
            },
          }),
      },
      code,
    );
    await client.hello();
    await client.open();
    await client.execute(
      "yield_control(); await new Promise(resolve => setTimeout(() => { globalThis.timerRan = true; resolve(); }, 60000));",
    );
    const terminate = client.request({ method: "session/terminate", sessionId: "s1", cellId: "1" });
    await callbacksClosed.promise;
    expect(client.capacity.active).toBe(1);
    expect(
      client.messages.some(
        (message) => message.type === "operation/response" && message.id === terminate.id,
      ),
    ).toBe(false);
    expect(worker.observations[0]!.context.timerRan).toBeUndefined();
    // The fake worker fixture has no live timers after close. Its unresolved lifetime models this gap.
    void client.abort();
  });

  it("does not acknowledge cancellation while the actual cell ESM is still suspended", async () => {
    const worker = vmWorkerLoader();
    const loader = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 10 } });
    const ready = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const callbacksClosed = Promise.withResolvers<void>();
    const events: CodeModeCellEvents = {
      emit: async () => {
        ready.resolve();
      },
      invoke: async () => null,
      notify: async () => undefined,
      cancelled: () => cancelled.promise,
      closeCallbacks: async () => {
        callbacksClosed.resolve();
      },
      stopped: vi.fn(async () => undefined),
    };
    const run = loader.run(
      codeModeInvocation(
        code,
        'text("ready"); await new Promise(resolve => { globalThis.__testResume = resolve; });',
      ),
      events,
    );
    await ready.promise;
    cancelled.resolve();
    await callbacksClosed.promise;
    expect(events.stopped).not.toHaveBeenCalled();
    const resume: unknown = worker.observations[0]!.context.__testResume;
    if (typeof resume !== "function")
      throw new Error("Suspended unit cell has no completion handle");
    resume();
    await expect(run).resolves.toMatchObject({ terminated: true });
    expect(events.stopped).toHaveBeenCalledOnce();
  });
});

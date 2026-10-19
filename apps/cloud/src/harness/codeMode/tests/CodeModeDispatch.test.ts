import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import {
  createCodeModeWorkerLoader,
  type CodeModeCellCode,
  type CodeModeCellEvents,
} from "../../CodeModeHost.ts";
import { hostClient } from "./client.ts";
import { codeModeInvocation, vmWorkerLoader } from "./vmLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

describe("queued CodeMode effects", () => {
  it("continues original ESM through two correlated tools and a native timer", async () => {
    const workers = vmWorkerLoader();
    const client = hostClient(
      createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 1000 } }),
      code,
    );
    await client.hello();
    await client.open();
    const source = `store("x", 0);
const cleared = setTimeout(() => { store("x", 9); text("cleared"); }, 0);
clearTimeout(cleared);
text("before");
text(await tools.echo({value: 1}));
await new Promise(resolve => setTimeout(resolve, 0));
text(await tools.echo({value: 2}));
setTimeout(() => { store("x", 1); text("late"); }, 60000);
notify("done");
`;
    const result = client.execute(source, {
      enabled_tools: [
        {
          name: "echo",
          tool_name: { name: "echo", namespace: null },
          description: "",
          kind: "function",
          input_schema: null,
          output_schema: null,
        },
      ],
    });
    for (const value of [1, 2]) {
      const delegate = await client.receive((message) => message.type === "delegate/request");
      expect(delegate.request).toMatchObject({
        type: "tool/invoke",
        invocation: { input: { value } },
      });
      client.send({
        type: "delegate/response",
        id: delegate.id,
        result: {
          status: "ok",
          value: { type: "tool/result", result: { echoed: value } },
        },
      });
    }
    const notification = await client.receive((message) => message.type === "delegate/request");
    expect(notification.request).toMatchObject({ type: "notification/send", text: "done" });
    client.send({
      type: "delegate/response",
      id: notification.id,
      result: { status: "error", message: "delivery failed" },
    });
    expect(await result).toMatchObject({
      result: {
        value: {
          Result: {
            error_text: null,
            content_items: ["before", '{"echoed":1}', '{"echoed":2}'].map((text) => ({
              type: "input_text",
              text,
            })),
          },
        },
      },
    });
    expect(await client.execute('text(load("x"));')).toMatchObject({
      result: { value: { Result: { content_items: [{ type: "input_text", text: "0" }] } } },
    });
    expect(workers.observations[0]?.source).toBe(source);
    expect(workers.observations[0]?.flags).toEqual(["new_module_registry"]);
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("reports output transport failure and unwinds an awaited tool before stopped", async () => {
    const workers = vmWorkerLoader();
    const invoked = Promise.withResolvers<void>();
    const order: string[] = [];
    const input = codeModeInvocation(code, 'text("before"); await tools.slow({}); text("after");');
    const events: CodeModeCellEvents = {
      emit: async () => {
        throw new Error("output transport failed");
      },
      invoke: () => {
        invoked.resolve();
        return new Promise(() => {});
      },
      notify: async () => undefined,
      cancelled: () => new Promise(() => {}),
      closeCallbacks: async () => {
        order.push("callbacks");
      },
      stopped: async () => {
        order.push("stopped");
      },
    };
    const run = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }).run(
      {
        ...input,
        request: {
          ...input.request,
          enabled_tools: [
            {
              name: "slow",
              tool_name: { name: "slow", namespace: null },
              description: "",
              kind: "function",
              input_schema: null,
              output_schema: null,
            },
          ],
        },
      },
      events,
    );
    await invoked.promise;
    await expect(run).resolves.toMatchObject({
      terminated: false,
      error: expect.stringContaining("output transport failed"),
    });
    expect(order).toEqual(["callbacks", "stopped"]);
  });

  it.each(["throw 'timer failed'", "exit()"])(
    "preserves accepted timer output before %s and drains notification delivery",
    async (terminal) => {
      const workers = vmWorkerLoader();
      const client = hostClient(
        createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }),
        code,
      );
      await client.hello();
      await client.open();
      const result = client.execute(
        `setTimeout(() => { text("before failure"); notify("timer done"); ${terminal}; }, 0); await tools.slow({});`,
        {
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
      );
      const tool = await client.receive((message) => message.type === "delegate/request");
      const notification = await client.receive((message) => message.type === "delegate/request");
      expect(notification.request).toMatchObject({ type: "notification/send", text: "timer done" });
      expect(client.messages.filter((message) => message.type === "delegate/cancel")).toEqual([]);
      client.send({
        type: "delegate/response",
        id: notification.id,
        result: { status: "error", message: "delivery failed" },
      });
      expect(await result).toMatchObject({
        result: {
          value: {
            Result: {
              error_text: terminal === "exit()" ? null : "timer failed",
              content_items: [{ type: "input_text", text: "before failure" }],
            },
          },
        },
      });
      expect(client.messages).toContainEqual({ type: "delegate/cancel", id: tool.id });
      await client.close();
      expect(client.capacity.active).toBe(0);
    },
  );
});

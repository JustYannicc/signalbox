import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import {
  createCodeModeWorkerLoader,
  type CodeModeCellCode,
  type CodeModeToolDefinition,
} from "../../CodeModeHost.ts";
import { hostClient } from "./client.ts";
import { vmWorkerLoader } from "./vmLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

function fixture() {
  const worker = vmWorkerLoader();
  const loader = createCodeModeWorkerLoader({ loader: worker.loader, policy: { cpuMs: 50 } });
  return { client: hostClient(loader, code), worker };
}

const tool = (name: string): CodeModeToolDefinition => ({
  name,
  tool_name: { name, namespace: null },
  description: `Tool ${name}`,
  kind: "function",
  input_schema: null,
  output_schema: null,
});
const result = (cell_id: string, texts: string[]) => ({
  Result: {
    cell_id,
    content_items: texts.map((text) => ({ type: "input_text", text })),
    error_text: null,
    code_mode_host_duration_ns: expect.any(Number),
  },
});

describe("CodeMode V1 host with isolated ESM unit fixture", () => {
  it("negotiates only implemented capabilities", async () => {
    const { client } = fixture();
    expect(
      await client.hello([], ["yield-observation", "session-cell-execution-resource-limits"]),
    ).toMatchObject({ selectedVersion: 1, capabilities: ["yield-observation"] });
    await client.close();
    const rejected = fixture().client;
    expect(await rejected.hello(["session-cell-execution-resource-limits"], [])).toMatchObject({
      type: "connection/rejected",
      reason: {
        type: "missingRequiredCapability",
        capability: "session-cell-execution-resource-limits",
      },
    });
    await rejected.finished;
  });

  it("executes original cell ESM and snapshots JSON stores across fresh isolates", async () => {
    const { client, worker } = fixture();
    await client.hello();
    await client.open();
    const source = 'store("key", "persisted"); globalThis.cellOnly = true;';
    expect(await client.execute(source)).toMatchObject({
      result: { status: "ok", value: result("1", []) },
    });
    expect(
      await client.execute(
        'text(load("key")); text(typeof cellOnly); text(typeof console); text(typeof WebAssembly);',
      ),
    ).toMatchObject({
      result: { value: result("2", ["persisted", "undefined", "undefined", "undefined"]) },
    });
    expect(worker.observations[0]!.source).toBe(source);
    expect(worker.observations[0]!.context).not.toBe(worker.observations[1]!.context);
    expect(
      worker.observations.every(
        (observation) => observation.cpuMs === 50 && observation.outbound === null,
      ),
    ).toBe(true);
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("keeps synchronous yield output ordered through a later wait", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    expect(await client.execute('text("before"); yield_control(); text("after");')).toMatchObject({
      result: {
        value: {
          Yielded: { cell_id: "1", content_items: [{ type: "input_text", text: "before" }] },
        },
      },
    });
    expect(await client.wait("1").response).toMatchObject({
      result: { value: { type: "wait/completed", outcome: { LiveCell: result("1", ["after"]) } } },
    });
    expect(await client.wait("1").response).toMatchObject({
      result: {
        value: { outcome: { MissingCell: { Result: { error_text: "exec cell 1 not found" } } } },
      },
    });
    await client.close();
  });

  it("ignores yields without an observer while retaining their buffered output", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    await client.execute(
      'yield_control(); await tools.release({}); text("buffered"); yield_control(); text("after"); await tools.barrier({});',
      { enabled_tools: [tool("release"), tool("barrier")] },
    );
    const release = await client.receive((message) => message.type === "delegate/request");
    client.send({
      type: "delegate/response",
      id: release.id,
      result: { status: "ok", value: { type: "tool/result", result: null } },
    });
    const barrier = await client.receive((message) => message.type === "delegate/request");
    const waited = client.wait("1");
    client.send({
      type: "delegate/response",
      id: barrier.id,
      result: { status: "ok", value: { type: "tool/result", result: null } },
    });
    try {
      expect(await waited.response).toMatchObject({
        result: { value: { outcome: { LiveCell: result("1", ["buffered", "after"]) } } },
      });
    } finally {
      await client.close();
    }
  });

  it("gives termination and its pending wait separate copies of terminal output", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    await client.execute('yield_control(); text("pending"); await tools.release({});', {
      enabled_tools: [tool("release")],
    });
    await client.receive((message) => message.type === "delegate/request");
    const wait = client.wait("1", 60_000);
    const terminate = client.request({ method: "session/terminate", sessionId: "s1", cellId: "1" });
    const expected = {
      result: {
        value: {
          outcome: {
            LiveCell: {
              Terminated: {
                cell_id: "1",
                content_items: [{ type: "input_text", text: "pending" }],
              },
            },
          },
        },
      },
    };
    expect(await wait.response).toMatchObject(expected);
    expect(await terminate.response).toMatchObject(expected);
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("forwards real tool arguments, metadata and results over delegate frames", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    const running = client.execute("text(ALL_TOOLS); text(await tools.echo({value: 42}));", {
      enabled_tools: [tool("echo")],
    });
    const delegate = await client.receive((message) => message.type === "delegate/request");
    expect(delegate).toMatchObject({
      sessionId: "s1",
      request: {
        type: "tool/invoke",
        invocation: {
          cell_id: "1",
          runtime_tool_call_id: "tool-1",
          tool_name: { name: "echo", namespace: null },
          tool_kind: "function",
          input: { value: 42 },
        },
      },
    });
    client.send({
      type: "delegate/response",
      id: delegate.id,
      result: { status: "ok", value: { type: "tool/result", result: { echoed: 42 } } },
    });
    expect(await running).toMatchObject({
      result: {
        value: result("1", ['[{"name":"echo","description":"Tool echo"}]', '{"echoed":42}']),
      },
    });
    await client.close();
  });

  it("terminates an awaited tool and cancels notifications before closing it", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    const running = client.execute(
      'notify("pending"); store("cancelled", true); yield_control(); await tools.slow({}); text("after cancellation");',
      { enabled_tools: [tool("slow")] },
    );
    const notification = await client.receive((message) => message.type === "delegate/request");
    expect(notification).toMatchObject({
      request: { type: "notification/send", callId: "call", cellId: "1", text: "pending" },
    });
    const invocation = await client.receive((message) => message.type === "delegate/request");
    expect(invocation).toMatchObject({ request: { type: "tool/invoke" } });
    await running;
    const terminate = client.request({ method: "session/terminate", sessionId: "s1", cellId: "1" });
    const cancelled = [
      await client.receive((message) => message.type === "delegate/cancel"),
      await client.receive((message) => message.type === "delegate/cancel"),
    ];
    expect(cancelled.map((message) => message.id)).toEqual([notification.id, invocation.id]);
    expect(await terminate.response).toMatchObject({
      result: {
        value: { outcome: { LiveCell: { Terminated: { cell_id: "1", content_items: [] } } } },
      },
    });
    expect(await client.execute('text(load("cancelled"));')).toMatchObject({
      result: { value: result("2", ["undefined"]) },
    });
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("cancels a wait observation without cancelling the cell", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    await client.execute("yield_control(); text(await tools.release({}));", {
      enabled_tools: [tool("release")],
    });
    const delegate = await client.receive((message) => message.type === "delegate/request");
    const wait = client.wait("1", 60_000);
    client.send({ type: "operation/cancel", id: wait.id });
    expect(await wait.response).toMatchObject({
      result: { status: "error", message: "code-mode request cancelled" },
    });
    client.send({
      type: "delegate/response",
      id: delegate.id,
      result: { status: "ok", value: { type: "tool/result", result: "still running" } },
    });
    expect(await client.wait("1").response).toMatchObject({
      result: { value: { outcome: { LiveCell: result("1", ["still running"]) } } },
    });
    await client.close();
  });

  it("drains a disconnect while its cell awaits an ordinary tool call", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    await client.execute("yield_control(); await tools.release({});", {
      enabled_tools: [tool("release")],
    });
    await client.receive((message) => message.type === "delegate/request");
    await client.abort();
    expect(client.capacity.active).toBe(0);
  });

  it("supports yield-observation without cancelling a running tool", async () => {
    const { client } = fixture();
    await client.hello();
    await client.open();
    const call = client.request({
      method: "session/execute",
      sessionId: "s1",
      request: {
        source: 'text("working"); text(await tools.release({}));',
        tool_call_id: "long",
        enabled_tools: [tool("release")],
        yield_time_ms: 60_000,
        max_output_tokens: null,
      },
    });
    await call.response;
    const delegate = await client.receive((message) => message.type === "delegate/request");
    client.send({ type: "operation/yield", id: call.id });
    expect(
      await client.receive(
        (message) => message.type === "execute/initialResponse" && message.id === call.id,
      ),
    ).toMatchObject({
      result: { value: { Yielded: { content_items: [{ type: "input_text", text: "working" }] } } },
    });
    client.send({
      type: "delegate/response",
      id: delegate.id,
      result: { status: "ok", value: { type: "tool/result", result: "done" } },
    });
    expect(await client.wait("1").response).toMatchObject({
      result: { value: { outcome: { LiveCell: result("1", ["done"]) } } },
    });
    await client.close();
  });

  it("rejects imports before executing them and leaves the session usable", async () => {
    const { client, worker } = fixture();
    await client.hello();
    await client.open();
    expect(
      await client.execute('const module = await import("cloudflare:workers"); text(module);'),
    ).toMatchObject({
      result: { value: { Result: { error_text: "CodeMode cells do not support imports" } } },
    });
    expect(worker.observations).toHaveLength(0);
    expect(await client.execute('text("alive");')).toMatchObject({
      result: { value: result("2", ["alive"]) },
    });
    await client.close();
  });

  it("keeps caught dynamic imports fail-closed while their resolver semantics remain unsupported", async () => {
    const { client, worker } = fixture();
    await client.hello();
    await client.open();
    expect(
      await client.execute('try { await import("x"); } catch { text("fallback"); }'),
    ).toMatchObject({
      result: {
        value: {
          Result: { error_text: "CodeMode cells do not support imports", content_items: [] },
        },
      },
    });
    expect(worker.observations).toHaveLength(0);
    await client.close();
  });
});

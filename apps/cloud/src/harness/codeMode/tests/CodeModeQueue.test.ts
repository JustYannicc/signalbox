import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import {
  createCodeModeWorkerLoader,
  type CodeModeCellCode,
  type CodeModeCellEvents,
} from "../../CodeModeHost.ts";
import { codeModeInvocation, vmWorkerLoader } from "./vmLoader.ts";

type ToolResult = Awaited<ReturnType<CodeModeCellEvents["invoke"]>>;
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const tool = (name: string) => ({
  name,
  tool_name: { name, namespace: null },
  description: "",
  kind: "function" as const,
  input_schema: null,
  output_schema: null,
});

function input(source: string) {
  const invocation = codeModeInvocation(code, source);
  return {
    ...invocation,
    request: { ...invocation.request, enabled_tools: [tool("slow"), tool("fast")] },
  };
}

describe("CodeMode handler I/O through the public loader", () => {
  it("keeps module helpers heap-only while delegates progress independently of ordered output", async () => {
    const workers = vmWorkerLoader();
    const firstEmitted = Promise.withResolvers<void>();
    const firstOutput = Promise.withResolvers<void>();
    const fastStarted = Promise.withResolvers<void>();
    const fastResumed = Promise.withResolvers<void>();
    const guestDone = Promise.withResolvers<void>();
    const slow = Promise.withResolvers<ToolResult>();
    const fast = Promise.withResolvers<ToolResult>();
    const notification = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const output: string[] = [];
    const events: CodeModeCellEvents = {
      emit: vi.fn(async (event) => {
        const value =
          event.type === "yield"
            ? "yield"
            : event.item.type === "input_text"
              ? event.item.text
              : event.item.type;
        output.push(value);
        if (output.length === 1) {
          firstEmitted.resolve();
          await firstOutput.promise;
        }
        if (value === "guest done") guestDone.resolve();
      }),
      invoke: vi.fn((_index, _argument, id) => {
        if (id === "tool-1") return slow.promise;
        fastStarted.resolve();
        return fast.promise;
      }),
      notify: vi.fn((text) => {
        if (text === "done") return notification.promise;
        fastResumed.resolve();
        return Promise.resolve();
      }),
      cancelled: () => cancelled.promise,
      closeCallbacks: vi.fn(async () => {
        cancelled.resolve();
      }),
      stopped: vi.fn(async () => undefined),
    };
    const source = `const argument = {value: 1};
text("first"); text("second");
image("data:image/png;base64,QQ==");
audio("data:audio/mp3;base64,QQ==");
generatedImage({image_url: "data:image/png;base64,QQ==", output_hint: "created"});
yield_control();
const slow = tools.slow(argument);
const fast = tools.fast({value: 2});
argument.value = 99;
notify("done");
const cleared = setTimeout(() => { throw "cleared callback ran"; }, 0);
clearTimeout(cleared);
const result = await fast;
store("fast", result); text(result); notify("fast resumed");
await slow;
text("guest done");
`;
    const run = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }).run(
      input(source),
      events,
    );
    try {
      await firstEmitted.promise;
      await fastStarted.promise;
      expect(events.invoke).toHaveBeenNthCalledWith(1, 0, { value: 1 }, "tool-1");
      expect(events.invoke).toHaveBeenNthCalledWith(2, 1, { value: 2 }, "tool-2");
      expect(output).toEqual(["first"]);
      expect(workers.observations[0]!.io.filter((call) => call.operation === "setTimeout")).toEqual(
        [],
      );
      fast.resolve("fast response");
      await fastResumed.promise;
      expect(output).toEqual(["first"]);
      expect(events.notify).toHaveBeenNthCalledWith(1, "done");
      expect(events.notify).toHaveBeenNthCalledWith(2, "fast resumed");
      firstOutput.resolve();
      slow.resolve(null);
      await guestDone.promise;
      expect(events.closeCallbacks).not.toHaveBeenCalled();
      expect(events.stopped).not.toHaveBeenCalled();
      notification.reject(new Error("delivery failed"));
      await expect(run).resolves.toEqual({
        terminated: false,
        error: null,
        writes: { fast: "fast response" },
      });
      expect(output).toEqual([
        "first",
        "second",
        "input_image",
        "input_audio",
        "input_image",
        "created",
        "yield",
        "fast response",
        "guest done",
      ]);
      expect(workers.observations[0]!.source).toBe(source);
      expect(workers.observations[0]!.io.every((call) => call.phase === "handler")).toBe(true);
      expect(events.stopped).toHaveBeenCalledOnce();
    } finally {
      firstOutput.resolve();
      slow.resolve(null);
      fast.resolve(null);
      notification.resolve();
      await run;
    }
  });

  it("cancels an awaited tool before later guest output, notification and timer effects", async () => {
    const workers = vmWorkerLoader();
    const invoked = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const events: CodeModeCellEvents = {
      emit: vi.fn(async () => undefined),
      invoke: vi.fn(() => {
        invoked.resolve();
        return new Promise<ToolResult>(() => {});
      }),
      notify: vi.fn(async () => undefined),
      cancelled: () => cancelled.promise,
      closeCallbacks: vi.fn(async () => undefined),
      stopped: vi.fn(async () => undefined),
    };
    const run = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }).run(
      input(`text("ready");
await tools.slow({});
text("discarded"); notify("discarded"); setTimeout(() => text("discarded"), 0);
`),
      events,
    );
    await invoked.promise;
    cancelled.resolve();
    await expect(run).resolves.toEqual({ terminated: true, error: null, writes: {} });
    expect(events.emit).toHaveBeenCalledExactlyOnceWith({
      type: "content",
      item: { type: "input_text", text: "ready" },
    });
    expect(events.invoke).toHaveBeenCalledOnce();
    expect(events.notify).not.toHaveBeenCalled();
    expect(events.closeCallbacks).toHaveBeenCalledOnce();
    expect(events.stopped).toHaveBeenCalledOnce();
    expect(workers.observations[0]!.io.filter((call) => call.operation === "setTimeout")).toEqual(
      [],
    );
    expect(workers.observations[0]!.io.every((call) => call.phase === "handler")).toBe(true);
  });

  it("detects direct module I/O before and after an await in its fixture calibration", async () => {
    const workers = vmWorkerLoader();
    const emitted: string[] = [];
    const events: CodeModeCellEvents = {
      emit: async (event) => {
        if (event.type === "content" && event.item.type === "input_text")
          emitted.push(event.item.text);
      },
      invoke: async () => null,
      notify: async () => undefined,
      cancelled: () => new Promise(() => {}),
      closeCallbacks: async () => undefined,
      stopped: async () => undefined,
    };
    // Deliberately unsafe test-owned bootstrap calibrates the observer without changing production.
    const fixtureCode = {
      mainModule: "fixture.js",
      modules: {
        "fixture.js": {
          js: `export default class {
  async run(input, events) {
    globalThis.emitFromModule = text => events.emit({type: "content", item: {type: "input_text", text}});
    await import("./__code_mode_evaluation.js");
    await events.closeCallbacks(); await events.stopped();
    return {terminated: false, error: null, writes: {}};
  }
}`,
        },
      },
    };
    const source =
      'emitFromModule("before"); await new Promise(resolve => setTimeout(resolve, 0)); emitFromModule("after");';
    await createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }).run(
      codeModeInvocation(fixtureCode, source),
      events,
    );
    expect(emitted).toEqual(["before", "after"]);
    expect(
      workers.observations[0]!.io.filter(
        (call) => call.operation === "emit" || call.operation === "setTimeout",
      ),
    ).toEqual([
      { operation: "emit", phase: "module-evaluation" },
      { operation: "setTimeout", phase: "module-evaluation" },
      { operation: "emit", phase: "module-evaluation" },
    ]);
  });
});

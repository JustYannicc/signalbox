import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import { createCodeModeWorkerLoader, type CodeModeCellCode } from "../../CodeModeHost.ts";
import { hostClient } from "./client.ts";
import { vmWorkerLoader } from "./vmLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

async function fixture() {
  const workers = vmWorkerLoader();
  const client = hostClient(
    createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }),
    code,
  );
  await client.hello();
  await client.open();
  return client;
}

const text = (value: string) => ({ type: "input_text", text: value });

describe("official CodeMode globals port", () => {
  it("drains natural notifications before completion and keeps delivery errors nonfatal", async () => {
    const client = await fixture();
    const call = client.request({
      method: "session/execute",
      sessionId: "s1",
      request: {
        source: 'notify("done"); text("completed");',
        tool_call_id: "notify",
        enabled_tools: [],
        yield_time_ms: 1000,
        max_output_tokens: null,
      },
    });
    await call.response;
    const notification = await client.receive((message) => message.type === "delegate/request");
    await client.execute('text("barrier");');
    expect(
      client.messages.filter(
        (message) =>
          message.type === "delegate/cancel" ||
          (message.type === "execute/initialResponse" && message.id === call.id),
      ),
    ).toEqual([]);
    client.send({
      type: "delegate/response",
      id: notification.id,
      result: { status: "error", message: "delivery failed" },
    });
    expect(
      await client.receive(
        (message) => message.type === "execute/initialResponse" && message.id === call.id,
      ),
    ).toMatchObject({
      result: { value: { Result: { error_text: null, content_items: [text("completed")] } } },
    });
    await client.close();
  });

  it.each(["delivered", "failed"])(
    "revokes completed guest timers while notification acknowledgement is %s",
    async (delivery) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const client = await fixture();
        const call = client.request({
          method: "session/execute",
          sessionId: "s1",
          request: {
            source:
              'store("x", 0); setTimeout(() => { text("late"); store("x", 1); }, 10); notify("done"); text("completed");',
            tool_call_id: "notify",
            enabled_tools: [],
            yield_time_ms: 1000,
            max_output_tokens: null,
          },
        });
        await call.response;
        const notification = await client.receive((message) => message.type === "delegate/request");
        // The ACK stays latched. Flush ESM promise jobs before making the guest timer due.
        await vi.advanceTimersByTimeAsync(10);
        expect(
          client.messages.filter(
            (message) =>
              message.type === "delegate/cancel" ||
              (message.type === "execute/initialResponse" && message.id === call.id),
          ),
        ).toEqual([]);
        client.send({
          type: "delegate/response",
          id: notification.id,
          result:
            delivery === "delivered"
              ? { status: "ok", value: { type: "notification/delivered" } }
              : { status: "error", message: "delivery failed" },
        });
        expect
          .soft(
            await client.receive(
              (message) => message.type === "execute/initialResponse" && message.id === call.id,
            ),
          )
          .toMatchObject({
            result: { value: { Result: { error_text: null, content_items: [text("completed")] } } },
          });
        expect.soft(await client.execute('text(load("x"));')).toMatchObject({
          result: { value: { Result: { error_text: null, content_items: [text("0")] } } },
        });
        await client.close();
        expect(client.capacity.active).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("serializes primitive text and clones store values on write and load", async () => {
    const client = await fixture();
    const output = await client.execute(`
text(); text(null); text(true); text(12n); text({a: 1});
const value = {nested: {n: 1}};
store("copy", value); value.nested.n = 2;
const loaded = load("copy"); loaded.nested.n = 3;
text(load("copy"));
`);
    expect(output).toMatchObject({
      result: {
        value: {
          Result: {
            error_text: null,
            content_items: [
              text("undefined"),
              text("null"),
              text("true"),
              text("12"),
              text('{"a":1}'),
              text('{"nested":{"n":1}}'),
            ],
          },
        },
      },
    });
    await client.close();
  });

  it("commits completed writes on thrown errors and exits without executing later statements", async () => {
    const client = await fixture();
    expect(await client.execute('store("failed", 7); throw "bad";')).toMatchObject({
      result: { value: { Result: { error_text: "bad" } } },
    });
    expect(
      await client.execute('text(load("failed")); text("before"); exit(); text("after");'),
    ).toMatchObject({
      result: {
        value: { Result: { error_text: null, content_items: [text("7"), text("before")] } },
      },
    });
    await client.close();
  });

  it("finishes a module exporting then without assimilating its namespace", async () => {
    const client = await fixture();
    expect(await client.execute('export function then() {} text("done");')).toMatchObject({
      result: { value: { Result: { error_text: null, content_items: [text("done")] } } },
    });
    await client.close();
    expect(client.capacity.active).toBe(0);
  });

  it("reports later errors after a caught exit", async () => {
    const client = await fixture();
    expect(await client.execute('try { exit(); } catch {} throw "bad";')).toMatchObject({
      result: { value: { Result: { error_text: "bad" } } },
    });
    await client.close();
  });

  it("runs awaited timers and cancels timers when their cell completes", async () => {
    const client = await fixture();
    expect(
      await client.execute(
        'setTimeout(() => text("late"), 30000); await new Promise(resolve => setTimeout(resolve, 0)); text("finished");',
      ),
    ).toMatchObject({
      result: { value: { Result: { error_text: null, content_items: [text("finished")] } } },
    });
    await client.close();
  });

  it("uses the unchanged official settlement helpers with ordered fulfillment and rejection", async () => {
    const client = await fixture();
    expect(
      await client.execute(
        'for await (const result of as_settled(new Map([["a", Promise.resolve(1)], ["b", Promise.reject("bad")]]))) text(result);',
      ),
    ).toMatchObject({
      result: {
        value: {
          Result: {
            error_text: null,
            content_items: [
              text('{"index":"a","status":"fulfilled","value":1}'),
              text('{"index":"b","status":"rejected","reason":"bad"}'),
            ],
          },
        },
      },
    });
    await client.close();
  });

  it("normalizes MCP images and generated images with official detail precedence", async () => {
    const client = await fixture();
    expect(
      await client.execute(
        'image({type:"image", data:"aGVsbG8=", mimeType:"image/png", _meta:{"codex/imageDetail":"low"}}, "original"); image("data:image/png;base64,QQ=="); generatedImage({image_url:"data:image/png;base64,Qg==", output_hint:"created"});',
      ),
    ).toMatchObject({
      result: {
        value: {
          Result: {
            error_text: null,
            content_items: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,aGVsbG8=",
                detail: "original",
              },
              { type: "input_image", image_url: "data:image/png;base64,QQ==", detail: "high" },
              { type: "input_image", image_url: "data:image/png;base64,Qg==", detail: "high" },
              text("created"),
            ],
          },
        },
      },
    });
    expect(await client.execute('image("https://example.com/image.png");')).toMatchObject({
      result: {
        value: {
          Result: {
            error_text:
              "Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead",
          },
        },
      },
    });
    await client.close();
  });

  it("omits tiny PCM WAV output using available frames, including streaming data sizes", async () => {
    const client = await fixture();
    const wav = new Uint8Array(44 + 480);
    const view = new DataView(wav.buffer);
    const put = (offset: number, value: string) => wav.set(new TextEncoder().encode(value), offset);
    put(0, "RIFF");
    view.setUint32(4, wav.length - 8, true);
    put(8, "WAVE");
    put(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, "data");
    view.setUint32(40, 0xffffffff, true);
    const url = `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`;
    expect(await client.execute(`audio(${JSON.stringify(url)});`)).toMatchObject({
      result: {
        value: {
          Result: {
            error_text: null,
            content_items: [
              text(
                "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.",
              ),
            ],
          },
        },
      },
    });
    await client.close();
  });
});

import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelAsyncWasi } from "../../kernel/KernelWasi.ts";
import { CodexExecSessions } from "../../kernel/CodexExecSessions.ts";
import { createCodexImports } from "../CodexImports.ts";
import { createCodexFetch } from "../CodexNetwork.ts";
import { fixture } from "./tests/fixture.ts";

function encodedRequest(url: string) {
  const name = new TextEncoder().encode(url);
  const bytes = new Uint8Array(20 + name.length);
  const view = new DataView(bytes.buffer);
  [1, 1024, 4096, name.length].forEach((value, index) => view.setUint32(index * 4, value, true));
  bytes.set(name, 16);
  return bytes;
}

describe("Codex imported model WebSocket route", () => {
  it.each([
    ["ws://model.invalid/v1/responses", "http://model.invalid/v1/responses"],
    ["wss://model.invalid/v1/responses", "https://model.invalid/v1/responses"],
  ])("routes %s through authorized model fetch and cleans its descriptor", async (url, target) => {
    // This synthetic module declares the real host ABI without running native guest code.
    const module = new WebAssembly.Module(
      new Uint8Array([
        0,
        97,
        115,
        109,
        1,
        0,
        0,
        0,
        1,
        8,
        1,
        96,
        3,
        127,
        127,
        127,
        1,
        127,
        2,
        27,
        1,
        15,
        ...new TextEncoder().encode("signalbox_ws_v1"),
        7,
        ...new TextEncoder().encode("ws_open"),
        0,
        0,
      ]),
    );
    const context = fixture(module);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const binding = createKernelAsyncWasi({ filesystem: context.files, wakes: context.wakes });
    const sessions = new CodexExecSessions({
      environmentInfo: context.options.environmentInfo,
      createSession: () => {
        throw new Error("Model socket cannot create an exec session");
      },
      onCleanupError: (error) => {
        throw error;
      },
    });
    const completion = Promise.withResolvers<{
      exitCode: number;
      signal: number;
      coreDumped: boolean;
    }>();
    const acquired = context.host.processes.spawn(
      undefined,
      () => ({
        completion: completion.promise,
        signal: () => ({ status: "ok", value: undefined }),
      }),
      () => undefined,
    );
    if (acquired.status !== "ok") throw new Error("Test process acquisition failed");
    const controller = new AbortController();
    const called = Promise.withResolvers<Request>();
    const external = vi.fn(async () => {
      throw new Error("Model upgrade escaped its route");
    });
    const model = vi.fn(async (request: Request) => {
      called.resolve(request);
      return new Response("upgrade refused", { status: 429 });
    });
    const fetch = createCodexFetch({
      computer: context.options.computer,
      signal: controller.signal,
      modelOrigins: [new URL(target).origin],
      modelTransport: model,
      fetch: external,
    });
    const imported = await createCodexImports({
      options: { ...context.options, fetch },
      binding,
      parent: acquired.value.handle,
      sessions,
      memory: () => memory,
      signal: controller.signal,
    });
    const open: unknown = imported.imports.signalbox_ws_v1?.ws_open;
    if (typeof open !== "function") throw new Error("Missing WebSocket ABI import");
    const bytes = encodedRequest(url);
    new Uint8Array(memory.buffer).set(bytes, 64);
    try {
      expect(open(64, bytes.length, 16)).toBe(0);
      const request = await called.promise;
      expect(request.url).toBe(target);
      expect(request.headers.get("upgrade")).toBe("websocket");
      expect(request.redirect).toBe("manual");
      expect(model).toHaveBeenCalledOnce();
      expect(external).not.toHaveBeenCalled();
      expect(context.port).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await imported.dispose();
      await sessions.dispose();
      await binding.wasi.close();
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await context.host.exitStatus(acquired.value.handle);
      expect(context.host.reap(acquired.value.handle).status).toBe("ok");
      expect(context.host.processes.size).toBe(0);
      await context.close();
    }
  });
});

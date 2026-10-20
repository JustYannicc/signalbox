import { describe, expect, it, vi } from "vite-plus/test";
import { createCodexFetch } from "../CodexNetwork.ts";
import type { Computer } from "../../computer/Computer.ts";

function routes() {
  const modelTransport = vi.fn(async (request: Request) => new Response(await request.text()));
  const fetch = vi.fn(async (request: Request) => new Response(await request.text()));
  const local = vi.fn(async (request: Request) => new Response(await request.text()));
  const port = vi.fn<Computer["port"]>(async () => ({ fetch: local }));
  const controller = new AbortController();
  const run = createCodexFetch({
    computer: { port },
    signal: controller.signal,
    modelOrigins: ["http://model.test", "http://localhost:7777"],
    modelTransport,
    fetch,
  });
  return { run, port, modelTransport, fetch, local, controller };
}

describe("Codex network routes", () => {
  it("routes exact model origins, loopback ports and other HTTP requests with their body intact", async () => {
    const context = routes();
    for (const url of ["http://model.test/v1/responses", "http://localhost:7777/v1/responses"])
      expect(
        await (await context.run(new Request(url, { method: "POST", body: "model" }))).text(),
      ).toBe("model");
    expect(context.modelTransport).toHaveBeenCalledTimes(2);
    expect(context.port).not.toHaveBeenCalled();
    expect(
      await (
        await context.run(new Request("http://127.0.0.1:4321/mcp", { method: "POST", body: "mcp" }))
      ).text(),
    ).toBe("mcp");
    expect(context.port.mock.calls[0]?.[0]).toBe(4321);
    expect(context.local).toHaveBeenCalledTimes(1);
    expect(
      await (
        await context.run(
          new Request("http://model.test.evil/tool", { method: "POST", body: "external" }),
        )
      ).text(),
    ).toBe("external");
    expect(context.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending port lookup before invoking its transport", async () => {
    const context = routes();
    const failure = new Error("session closed");
    context.port.mockImplementation(async (_port, signal) => {
      context.controller.abort(failure);
      expect(signal.aborted).toBe(true);
      return { fetch: context.local };
    });
    await expect(context.run(new Request("http://[::1]:8080/tool"))).rejects.toBe(failure);
    expect(context.local).not.toHaveBeenCalled();
    await expect(context.run(new Request("http://model.test/v1/responses"))).rejects.toBe(failure);
    expect(context.modelTransport).not.toHaveBeenCalled();
  });

  it("rejects non-origin model routes", () => {
    const context = routes();
    expect(() =>
      createCodexFetch({
        ...context,
        computer: { port: context.port },
        signal: context.controller.signal,
        modelOrigins: ["http://model.test/v1"],
      }),
    ).toThrow("explicit HTTP origins");
  });
});

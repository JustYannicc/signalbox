import { expect, it, vi } from "vite-plus/test";
import { ClaudeKernelNetworkTarget } from "../ClaudeKernelNetworkPort.ts";
import { claudeKernelComputer } from "../ClaudeKernelComputer.ts";
import type { ClaudeKernelSessionPort } from "../ClaudeKernelSessionPort.ts";
import { rpcRequest } from "../../rpc/Request.ts";
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("forwards host request cancellation after remote response headers", async () => {
  const lifetime = new AbortController();
  const cancelled = Promise.withResolvers<void>();
  const target = new ClaudeKernelNetworkTarget(
    {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([42]));
            },
          }),
        ),
    },
    lifetime.signal,
    () => {},
  );
  const cancel = vi.fn(async (id: string, reason?: unknown) => {
    await target.cancel(id, reason);
    cancelled.resolve();
  });
  const kernel = {
    port: async () => ({ fetch: target.fetch.bind(target), cancel }),
    cancel: async () => target.dispose(),
  } as unknown as ClaudeKernelSessionPort;
  const computer = claudeKernelComputer(kernel, "thread", "files", lifetime.signal);
  const port = await computer.port(8080, lifetime.signal);
  const request = new AbortController();
  const response = await port.fetch(
    new Request("https://port.invalid", { signal: request.signal }),
  );
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([42]));
  const reason = new Error("host caller left");
  request.abort(reason);
  await cancelled.promise;
  expect(cancel).toHaveBeenCalledWith(expect.any(String), reason);
  await target.dispose();
  lifetime.abort();
});

it("delivers cancellation that arrives before its network request", async () => {
  const fetch = vi.fn(async () => new Response());
  const target = new ClaudeKernelNetworkTarget({ fetch }, new AbortController().signal, () => {});
  const reason = new Error("cancelled before arrival");
  await target.cancel("early", reason);
  await expect(target.fetch("early", rpcRequest(new Request("https://port.invalid")))).rejects.toBe(
    reason,
  );
  expect(fetch).not.toHaveBeenCalled();
  await target.dispose();
});

it("keeps cancellation alive after headers until the response body closes", async () => {
  const cancelled = Promise.withResolvers<void>();
  const removed = vi.fn();
  const target = new ClaudeKernelNetworkTarget(
    {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([42]));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        ),
    },
    new AbortController().signal,
    removed,
  );
  const response = await target.fetch("stream", rpcRequest(new Request("https://port.invalid")));
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([42]));
  await target.cancel("stream", new Error("caller left"));
  await cancelled.promise;
  await target.dispose();
  expect(removed).toHaveBeenCalledTimes(1);
});

it("joins a pending fetch on owner disposal and rejects later requests", async () => {
  const entered = Promise.withResolvers<void>();
  const removed = vi.fn();
  const target = new ClaudeKernelNetworkTarget(
    {
      fetch: (request) => {
        entered.resolve();
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          }),
        );
      },
    },
    new AbortController().signal,
    removed,
  );
  const pending = target.fetch("pending", rpcRequest(new Request("https://port.invalid")));
  const failed = expect(pending).rejects.toThrow("Kernel network port closed");
  await entered.promise;
  await target.dispose();
  await failed;
  await expect(
    target.fetch("late", rpcRequest(new Request("https://port.invalid"))),
  ).rejects.toThrow("closed");
  expect(removed).toHaveBeenCalledTimes(1);
});

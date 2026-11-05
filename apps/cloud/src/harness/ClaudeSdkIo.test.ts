import { expect, it } from "vite-plus/test";
import { claudeSdkModelTransport } from "./ClaudeSdkIo.ts";

it("keeps request cancellation live after RPC response headers arrive", async () => {
  const controller = new AbortController();
  const cancelled = Promise.withResolvers<string>();
  let started = "";
  const transport = claudeSdkModelTransport({
    model: async (id) => {
      started = id;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
    },
    cancelIo: async (id) => {
      cancelled.resolve(id);
    },
  });
  const response = await transport(
    new Request("https://model.test/stream", { signal: controller.signal }),
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  controller.abort(new Error("turn cancelled"));
  expect(await cancelled.promise).toBe(started);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  reader.releaseLock();
});

it("releases the request's cancellation listener after the RPC body ends", async () => {
  const controller = new AbortController();
  const cancelled: string[] = [];
  const transport = claudeSdkModelTransport({
    model: async () => new Response("complete"),
    cancelIo: async (id) => {
      cancelled.push(id);
    },
  });
  const response = await transport(
    new Request("https://model.test/stream", { signal: controller.signal }),
  );
  expect(await response.text()).toBe("complete");
  controller.abort();
  expect(cancelled).toEqual([]);
});

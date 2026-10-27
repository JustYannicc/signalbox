import { expect, it } from "vite-plus/test";
import {
  createHarnessCProductExecutorService,
  productExecutor,
  type HarnessCProductExecutorService,
} from "../HarnessCProductCapabilities.ts";

it("carries the injected gateway endpoint through both executor RPC adapters", async () => {
  const endpoint = "https://tools-gateway.test/mcp";
  let observedEndpoint: string | undefined;
  const localExecutor = {
    async forward(input: { readonly gatewayEndpoint?: string }) {
      observedEndpoint = input.gatewayEndpoint;
      return new Response("gateway");
    },
  };
  const service = createHarnessCProductExecutorService(localExecutor);
  const request = new Request("https://harness-mcp.invalid/turn", { method: "POST", body: "call" });
  const signal = new AbortController().signal;
  const response = await productExecutor(service).forward({
    target: { type: "executor" },
    grant: "short-lived-turn-grant",
    gatewayEndpoint: endpoint,
    request,
    signal,
  });
  expect(observedEndpoint).toBe(endpoint);
  expect(await response.text()).toBe("gateway");
});

it("cancels an in-flight executor action when its request aborts", async () => {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let cancellation: ReadableStream<Uint8Array> | undefined;
  let stopped = false;
  const service: HarnessCProductExecutorService<string> = {
    async forward(input) {
      if ("cancellation" in input && input.cancellation instanceof ReadableStream)
        cancellation = input.cancellation;
      started.resolve();
      if (cancellation !== undefined) {
        const reader = cancellation.getReader();
        await reader.read();
        stopped = true;
        reader.releaseLock();
      } else await finished.promise;
      return { status: 200, statusText: "OK", headers: [], body: new Uint8Array() };
    },
  };
  const controller = new AbortController();
  const reason = new Error("request stopped");
  const forwarding = productExecutor(service).forward({
    target: { type: "executor" },
    grant: "per-request-grant",
    request: new Request("https://executor.invalid/mcp", { method: "POST", body: "tool call" }),
    signal: controller.signal,
  });
  const rejected = expect(forwarding).rejects.toBe(reason);
  await started.promise;
  controller.abort(reason);
  finished.resolve();
  await rejected;
  expect(stopped).toBe(true);
});

import { readRpcData } from "../../rpc/Resources.ts";
import type { ExecutorMcpPort } from "../HarnessSessionHost.ts";
import type { HarnessCProductExecutorService } from "./contracts.ts";

export function productExecutor<G>(service: HarnessCProductExecutorService<G>): ExecutorMcpPort<G> {
  return {
    forward: async (input) => {
      input.signal.throwIfAborted();
      const request = new Request(input.request, { signal: input.signal });
      const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
      input.signal.throwIfAborted();
      let removeAbortListener = () => {};
      const cancellation = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.close();
          input.signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) {
            removeAbortListener();
            abort();
          }
        },
        cancel: () => removeAbortListener(),
      });
      try {
        const response = await readRpcData(
          service.forward({
            target: input.target,
            grant: input.grant,
            ...(input.gatewayEndpoint === undefined
              ? {}
              : { gatewayEndpoint: input.gatewayEndpoint }),
            request: {
              url: request.url,
              method: request.method,
              headers: [...request.headers.entries()].map(([name, value]) => ({ name, value })),
              body,
            },
            cancellation,
          }),
        );
        input.signal.throwIfAborted();
        const headers: [string, string][] = response.headers.map(({ name, value }) => [
          name,
          value,
        ]);
        return new Response(response.body.slice(), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (cause) {
        input.signal.throwIfAborted();
        throw cause;
      } finally {
        removeAbortListener();
      }
    },
  };
}

/** The receiving capability owns the real forward and joins its cancellation reader. */
export function createHarnessCProductExecutorService<G>(
  executor: ExecutorMcpPort<G>,
): HarnessCProductExecutorService<G> {
  return {
    async forward(input) {
      const controller = new AbortController();
      const reader = input.cancellation.getReader();
      let finished = false;
      const cancelled = reader.read().then(
        () => {
          if (!finished) controller.abort();
        },
        (cause) => {
          if (!finished) controller.abort(cause);
        },
      );
      try {
        const request = new Request(input.request.url, {
          method: input.request.method,
          headers: input.request.headers.map(({ name, value }): [string, string] => [name, value]),
          body: input.request.body?.slice() ?? null,
          signal: controller.signal,
        });
        const response = await executor.forward({
          target: input.target,
          grant: input.grant,
          ...(input.gatewayEndpoint === undefined
            ? {}
            : { gatewayEndpoint: input.gatewayEndpoint }),
          request,
          signal: controller.signal,
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()].map(([name, value]) => ({ name, value })),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      } finally {
        finished = true;
        await reader.cancel().catch(() => {});
        await cancelled;
        reader.releaseLock();
      }
    },
  };
}

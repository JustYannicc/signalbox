import { Agent, fetch as stageFetch } from "undici";
import { waitForProbeRouter } from "./readiness.ts";
import { requestJson } from "./transport.ts";

export function createStageTransport(endpoint: string, secret: string, versionId: string) {
  const origin = new URL(endpoint).origin;
  const agent = new Agent({ connections: 1, pipelining: 1 });
  // Undici 8 dispatchers require Undici fetch rather than Node's older bundled fetch.
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body;
    async function* chunks(stream: NonNullable<Request["body"]>) {
      const reader = stream.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }
    const response = await stageFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      signal: request.signal,
      redirect: "error",
      dispatcher: agent,
      ...(body ? { body: chunks(body), duplex: "half" } : {}),
    });
    const bytes = await response.arrayBuffer();
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes,
      {
        status: response.status,
        headers: [...response.headers],
      },
    );
  };
  return {
    async request(url: URL, init: RequestInit, wrapResult = false) {
      if (url.origin !== origin) throw new Error("Probe request left its owned stage.");
      // Parent-process readiness cannot attest a fresh measurement connection or a later case.
      await waitForProbeRouter(endpoint, secret, {
        expectedVersionId: versionId,
        fetch: (request) => fetcher(request),
        ...(init.signal ? { signal: init.signal } : {}),
        onPending: (reason) => process.stderr.write(`Probe case setup pending: ${reason}.\n`),
      });
      return requestJson(url, init, wrapResult, fetcher);
    },
    close: () => agent.close(),
  };
}

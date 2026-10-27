import { Agent, fetch as stageFetch } from "undici";
import { waitForProbeRouter } from "./readiness.ts";
import { requestJson } from "./transport.ts";

export function createStageTransport(endpoint: string, secret: string, versionId: string) {
  const origin = new URL(endpoint).origin;
  const agent = new Agent({ connections: 1, pipelining: 1, allowH2: false });
  let generation = 0;
  let healthGeneration: number | undefined;
  let preDispatchFailure: Error | undefined;
  agent.on("connect", () => {
    generation++;
  });
  const dispatcher = agent.compose(
    (dispatch) => (options, handler) =>
      dispatch(
        { ...options, idempotent: false },
        {
          onRequestStart(controller, context) {
            handler.onRequestStart?.(controller, context);
            // This hook runs before HTTP/1 writes headers, including after a reconnect.
            if (options.path !== "/probe/health" && generation !== healthGeneration) {
              preDispatchFailure = new Error(
                "Probe stage connection changed before case dispatch.",
              );
              controller.abort(preDispatchFailure);
            }
          },
          onRequestUpgrade: (...args) => handler.onRequestUpgrade?.(...args),
          onResponseStart: (...args) => handler.onResponseStart?.(...args),
          onResponseData: (...args) => handler.onResponseData?.(...args),
          onResponseEnd: (...args) => handler.onResponseEnd?.(...args),
          onResponseError: (...args) => handler.onResponseError?.(...args),
          onResponseStarted: () => handler.onResponseStarted?.(),
          onBodySent: (...args) => handler.onBodySent?.(...args),
          onRequestSent: () => handler.onRequestSent?.(),
        },
      ),
  );
  // Undici 8 dispatchers require Undici fetch rather than Node's older bundled fetch.
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body;
    // Standard Request bodies are streams; Undici 8 accepts async byte iterables.
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
      dispatcher,
      ...(body ? { body: chunks(body), duplex: "half" } : {}),
    });
    const bytes = await response.arrayBuffer();
    if (new URL(request.url).pathname === "/probe/health") healthGeneration = generation;
    // The shared readiness and evidence code consumes the runtime's standard Response.
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes,
      {
        status: response.status,
        headers: [...response.headers],
      },
    );
  };
  return {
    async request(url: URL, createInit: () => RequestInit, wrapResult = false) {
      if (url.origin !== origin) throw new Error("Probe request left its owned stage.");
      const session = url.searchParams.get("session");
      if (!session) throw new Error("Probe case requires a destination session.");
      preDispatchFailure = undefined;
      // Parent-process readiness cannot attest a fresh measurement connection or a later case.
      try {
        await waitForProbeRouter(endpoint, secret, {
          expectedVersionId: versionId,
          session,
          fetch: (request) => fetcher(request),
          onPending: (reason) => process.stderr.write(`Probe case setup pending: ${reason}.\n`),
        });
      } catch (error) {
        throw preDispatchFailure ?? error;
      }
      const result = await requestJson(url, createInit(), wrapResult, fetcher);
      if (preDispatchFailure) throw preDispatchFailure;
      return result;
    },
    close: () => agent.close(),
  };
}

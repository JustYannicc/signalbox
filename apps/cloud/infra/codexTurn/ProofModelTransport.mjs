import { createKernelWebSocketFetchRoute } from "../../src/kernel/KernelWebSocketFetchRoute.ts";
import { createProofModelCpu, observeProofSocket } from "./ProofModelCpu.mjs";
import { createMockResponsesWebSocket } from "./MockResponsesWebSocket.mjs";

export function createLocalProofModel({ mock, request }) {
  const input = new URL(request.url);
  const peer = createMockResponsesWebSocket({
    mock,
    faults: {
      closeBeforeCompletedOnce: input.searchParams.get("disconnect") === "once",
      closeBeforeOutputOnce: input.searchParams.get("disconnect") === "early",
    },
  });
  return {
    ...peer,
    route(input) {
      const response = peer.route(input);
      response.webSocket?.accept();
      return response;
    },
  };
}

/** A mock network peer selected by the maintainer proof, never by a model request. */
export function createProofModelTransport({ request, context, execution }) {
  const input = new URL(request.url);
  const base = input.searchParams.get("model");
  if (!base) throw new Error("Network model proof requires its owned mock endpoint");
  const endpoint = new URL(base);
  const http = input.searchParams.get("transport") === "http";
  const cpu = createProofModelCpu({ context, execution, mode: input.searchParams.get("cpu") });
  const metrics = { opens: 0, httpRequests: 0, handshakes: [], errors: [] };
  const dial = createKernelWebSocketFetchRoute(async (upgrade) => {
    metrics.opens++;
    cpu?.dialStarted();
    const target = new URL(upgrade.url);
    const disconnect = input.searchParams.get("disconnect");
    if (disconnect) target.searchParams.set("disconnect", disconnect);
    if (input.searchParams.get("hold") === "once") target.searchParams.set("hold", "once");
    if (cpu) {
      target.searchParams.set("pace", "true");
      target.searchParams.set("cpu", "only");
    }
    try {
      const response = await fetch(new Request(target, upgrade));
      if (response.webSocket) cpu?.createdSocket();
      metrics.handshakes.push(response.status);
      if (response.status !== 101)
        metrics.errors.push((await response.clone().text()).slice(0, 2000));
      return response;
    } catch (error) {
      metrics.errors.push(String(error));
      throw error;
    }
  });
  return {
    baseUrl: http ? "http://mock.invalid/v1" : endpoint.href,
    supportsWebSockets: !http,
    cpuOnly: cpu?.cpuOnly ?? false,
    execSocket: cpu?.execSocket,
    ...(cpu ? { streamIdleTimeoutMs: 90000, watchdogMs: 90000 } : {}),
    async route(input) {
      const result = await dial(input);
      const socket = result.response.webSocket;
      if (!socket || !cpu) return result;
      cpu.acceptedSocket();
      return {
        status: result.response.status,
        headers: result.headers,
        webSocket: observeProofSocket(socket, cpu),
      };
    },
    diagnostics: () => ({ client: metrics }),
    async http(request) {
      metrics.httpRequests++;
      if (!http) throw new Error("Unexpected HTTP fallback in WebSocket proof");
      const target = new URL(endpoint);
      target.pathname += new URL(request.url).pathname.slice("/v1".length);
      return fetch(new Request(target, request));
    },
    async inspect() {
      const target = new URL(endpoint);
      target.pathname = target.pathname.replace(/\/v1\/?$/, "/status");
      const response = await fetch(target);
      if (!response.ok) throw new Error(`Model inspection failed: ${response.status}`);
      const peer = await response.json();
      if (http ? peer.metrics.opens !== 0 : metrics.opens < 1 || peer.httpRequests !== 0)
        throw new Error("Model used the wrong transport");
      return { ...peer, client: metrics, ...(cpu ? { cpu: cpu.inspect() } : {}) };
    },
  };
}

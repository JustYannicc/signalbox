import { describe, expect, it } from "vite-plus/test";
import { createKernelWebSocketFetchRoute } from "../KernelWebSocketFetchRoute.ts";
import type { KernelWebSocketRouteRequest } from "../KernelWebSocketHost.ts";

function routeRequest(
  url: string,
  signal = new AbortController().signal,
): KernelWebSocketRouteRequest {
  const headers: Array<[string, string]> = [
    ["authorization", "Bearer fixture"],
    ["openai-beta", "responses_websockets=2026-02-06"],
  ];
  return {
    request: new Request(url, { headers, signal }),
    headers,
    authority: new URL(url).host,
    signal,
  };
}

function upgradeResponse() {
  const calls: string[] = [];
  const response = new Response(null, {
    headers: [
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ],
  });
  // Node cannot construct a 101 Response; the fetch port returns one in workerd.
  Object.defineProperties(response, {
    status: { value: 101 },
    webSocket: { value: { accept: () => calls.push("accept"), close: () => calls.push("close") } },
  });
  return { response, calls };
}

describe("createKernelWebSocketFetchRoute", () => {
  it.each([
    ["ws://model.invalid/v1/responses", "http://model.invalid/v1/responses"],
    ["wss://model.invalid/v1/responses", "https://model.invalid/v1/responses"],
  ])("dials %s through the supplied authority with native TLS", async (url, expected) => {
    const { response, calls } = upgradeResponse();
    let received: Request | undefined;
    const route = createKernelWebSocketFetchRoute(async (request) => {
      received = request;
      return response;
    });
    const result = await route(routeRequest(url));
    expect(received?.url).toBe(expected);
    expect(received?.headers.get("authorization")).toBe("Bearer fixture");
    expect(received?.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
    expect(received?.headers.get("upgrade")).toBe("websocket");
    expect(result).toMatchObject({
      response,
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
    });
    expect(calls).toEqual(["accept"]);
  });

  it("preserves a rejected upgrade and its body", async () => {
    const response = new Response("retry later", { status: 429, headers: { "retry-after": "2" } });
    const route = createKernelWebSocketFetchRoute(async () => response);
    const result = await route(routeRequest("wss://model.invalid/v1/responses"));
    expect("response" in result && result.response).toBe(response);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("retry later");
    expect(result.headers).toContainEqual(["retry-after", "2"]);
  });

  it("closes a late upgrade when the dialer ignored cancellation", async () => {
    const abort = new AbortController();
    const { response, calls } = upgradeResponse();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const route = createKernelWebSocketFetchRoute(() => pending);
    const opened = route(routeRequest("wss://model.invalid/v1/responses", abort.signal));
    abort.abort(new Error("turn canceled"));
    resolve(response);
    await expect(opened).rejects.toThrow("turn canceled");
    expect(calls).toEqual(["accept", "close"]);
  });

  it("returns a redirect handshake without following its destination", async () => {
    const requests: Request[] = [];
    const response = new Response("upgrade moved", {
      status: 302,
      headers: { location: "https://other.invalid/responses" },
    });
    const route = createKernelWebSocketFetchRoute(async (request) => {
      requests.push(request);
      return response;
    });
    const result = await route(routeRequest("wss://model.invalid/v1/responses"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    expect("response" in result && result.response.status).toBe(302);
    expect(result.headers).toContainEqual(["location", "https://other.invalid/responses"]);
    expect(await response.text()).toBe("upgrade moved");
  });
});

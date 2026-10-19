import type { KernelWebSocketRoute } from "./KernelWebSocketHost.ts";

/** The supplied fetch owns network authority; workerd owns TLS and control frames. */
export function createKernelWebSocketFetchRoute(
  fetchUpgrade: (request: Request) => Promise<Response>,
): KernelWebSocketRoute {
  return async ({ request, signal }) => {
    signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new TypeError("Expected a ws/wss upgrade URL");
    }
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const headers = new Headers(request.headers);
    headers.set("upgrade", "websocket");
    const response = await fetchUpgrade(new Request(url, { headers, signal }));
    const socket = response.webSocket;
    if (socket != null) {
      socket.accept();
      // A dialer can finish after cancellation even if it ignored the request signal.
      if (signal.aborted) {
        socket.close(1000, "");
        signal.throwIfAborted();
      }
    }
    const pairs: Array<readonly [string, string]> = [];
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== "set-cookie") pairs.push([name, value]);
    }
    for (const value of response.headers.getSetCookie()) pairs.push(["set-cookie", value]);
    return { response, headers: pairs };
  };
}

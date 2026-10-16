// @effect-diagnostics globalFetch:off - a socket the container opened passes through the Workers runtime's own fetch, outside Effect.

/**
 * A WebSocket the container opens through its egress check (the Runner's own
 * socket to the cloud, a dev server's), bridged to its destination. workerd
 * carries a socket back to the container only when the handler answers with
 * its own `WebSocketPair`; one passed through from `fetch` is dropped. Frames
 * go both ways as they are; either side closing closes the other.
 */

export const isWebSocketUpgrade = (request: Request) =>
  (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

const closeCode = (code: number) =>
  // 1005 and 1006 only report what happened; they can't be sent.
  code === 1005 || code === 1006 ? 1000 : code;

export async function bridgeWebSocket(
  request: Request,
  connect: (request: Request) => Promise<Response> = (outgoing) => fetch(outgoing),
): Promise<Response> {
  const upstream = await connect(request);
  const remote = upstream.webSocket;
  if (remote === null || remote === undefined) return upstream;
  const [client, local] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  remote.accept();
  local.accept();
  const relay = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (event) => {
      try {
        to.send(event.data);
      } catch {
        from.close(1011, "The other side went away.");
      }
    });
    from.addEventListener("close", (event) => {
      try {
        to.close(closeCode(event.code), event.reason);
      } catch {
        // Already closed.
      }
    });
    from.addEventListener("error", () => {
      try {
        to.close(1011, "The other side failed.");
      } catch {
        // Already closed.
      }
    });
  };
  relay(remote, local);
  relay(local, remote);
  const headers = new Headers();
  const protocol = upstream.headers.get("sec-websocket-protocol");
  if (protocol !== null) headers.set("sec-websocket-protocol", protocol);
  return new Response(null, { status: 101, webSocket: client, headers });
}

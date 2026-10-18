// @effect-diagnostics preferSchemaOverJson:off - exec-server envelopes are encoded at the native WebSocket boundary.
import type { CodexExecSessions } from "./CodexExecSessions.ts";
import { encodeMessage } from "./CodexExecProtocol.ts";

/** The caller resolves session authority before handing a kernel-local upgrade to this adapter. */
export function acceptCodexExecWebSocket(
  request: Request,
  sessions: CodexExecSessions,
  lifetime: Pick<DurableObjectState, "waitUntil">,
): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept();
  const connection = sessions.connect(
    (message) => {
      server.send(encodeMessage(message));
    },
    (code, reason) => {
      if (server.readyState === WebSocket.OPEN) server.close(code, reason);
    },
  );
  const close = (code: number, reason: string) => {
    if (server.readyState === WebSocket.OPEN) server.close(code, reason);
    connection.disconnect();
  };
  server.addEventListener("message", (event) => {
    let text: string;
    try {
      text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder("utf-8", { fatal: true }).decode(event.data);
    } catch {
      close(1007, "Expected UTF-8 JSON");
      return;
    }
    const work = connection
      .receive(text)
      .then(() => {
        if (connection.closed) close(1002, "Exec-server protocol error");
      })
      .catch(() => close(1011, "Exec-server transport failed"));
    lifetime.waitUntil(work);
  });
  server.addEventListener("close", () => connection.disconnect());
  server.addEventListener("error", () => close(1011, "Exec-server transport failed"));
  return new Response(null, { status: 101, webSocket: client });
}

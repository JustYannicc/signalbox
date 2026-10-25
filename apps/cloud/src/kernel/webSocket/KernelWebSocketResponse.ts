import type {
  KernelWebSocketRouteResult,
  KernelWebSocketResponseWithHeaders,
  KernelWebSocketWebSocket,
} from "./KernelWebSocketTypes.ts";
import {
  MAX_HANDSHAKE_BODY_BYTES,
  WS_ERRNO,
  type KernelWebSocketHandshake,
} from "./KernelWebSocketWire.ts";

export interface NormalizedWebSocketRouteResponse {
  readonly handshake: KernelWebSocketHandshake;
  readonly webSocket?: KernelWebSocketWebSocket;
}

export class WebSocketRouteError extends Error {
  readonly errno: number;

  constructor(errno: number, message: string) {
    super(message);
    this.name = "WebSocketRouteError";
    this.errno = errno;
  }
}

export async function normalizeWebSocketRouteResponse(
  result: KernelWebSocketRouteResult,
  signal: AbortSignal,
): Promise<NormalizedWebSocketRouteResponse> {
  try {
    if (result instanceof Response) {
      throw new WebSocketRouteError(
        WS_ERRNO.EIO,
        "WebSocket adapter must supply raw header pairs with its Response",
      );
    }
    if (isResponseWithHeaders(result)) return await normalizeResponseWithHeaders(result, signal);
    if (
      typeof result !== "object" ||
      result === null ||
      !Number.isSafeInteger(result.status) ||
      !Array.isArray(result.headers)
    ) {
      throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket router returned an invalid response");
    }
    const body = result.body ?? new Uint8Array();
    if (!(body instanceof Uint8Array)) {
      throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket router returned an invalid body");
    }
    if (body.byteLength > MAX_HANDSHAKE_BODY_BYTES) {
      throw new WebSocketRouteError(WS_ERRNO.EMSGSIZE, "WebSocket response body is too large");
    }
    if (result.status === 101 && result.webSocket == null) {
      throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket upgrade did not return a socket");
    }
    return {
      handshake: {
        status: result.status,
        headers: result.headers.map(([name, value]) => [name, value] as const),
        body: body.slice(),
      },
      ...(result.webSocket == null ? {} : { webSocket: result.webSocket }),
    };
  } catch (error) {
    closeResponseSocket(result);
    throw error;
  }
}

function isResponseWithHeaders(result: unknown): result is KernelWebSocketResponseWithHeaders {
  return typeof result === "object" && result !== null && "response" in result;
}

function closeResponseSocket(result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const socket =
    result instanceof Response
      ? getResponseWebSocket(result)
      : isResponseWithHeaders(result)
        ? getResponseWebSocket(result.response)
        : "webSocket" in result
          ? (result.webSocket as KernelWebSocketWebSocket | null | undefined)
          : undefined;
  try {
    if (socket != null && (socket.readyState === 0 || socket.readyState === 1))
      socket.close(1000, "");
  } catch {
    // The invalid response cannot be handed to the resource for later cleanup.
  }
}

async function normalizeResponseWithHeaders(
  result: KernelWebSocketResponseWithHeaders,
  signal: AbortSignal,
): Promise<NormalizedWebSocketRouteResponse> {
  const { response, headers } = result;
  if (!(response instanceof Response) || !Array.isArray(headers)) {
    throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket adapter returned an invalid response");
  }
  const webSocket = getResponseWebSocket(response);
  if (response.status === 101 && webSocket === undefined) {
    throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket upgrade did not return a socket");
  }

  return {
    handshake: {
      status: response.status,
      headers: headers.map(([name, value]) => [name, value] as const),
      body: await readLimitedBody(response.body, signal),
    },
    ...(webSocket === undefined ? {} : { webSocket }),
  };
}

function getResponseWebSocket(response: Response): KernelWebSocketWebSocket | undefined {
  return (
    (response as Response & { readonly webSocket?: KernelWebSocketWebSocket | null }).webSocket ??
    undefined
  );
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted)
      throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket response was cancelled");
    for (;;) {
      const result = await reader.read();
      if (signal.aborted)
        throw new WebSocketRouteError(WS_ERRNO.EIO, "WebSocket response was cancelled");
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_HANDSHAKE_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new WebSocketRouteError(WS_ERRNO.EMSGSIZE, "WebSocket response body is too large");
      }
      chunks.push(result.value.slice());
    }
  } catch (error) {
    if (error instanceof WebSocketRouteError) throw error;
    throw new WebSocketRouteError(WS_ERRNO.EIO, "Could not read WebSocket response body");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

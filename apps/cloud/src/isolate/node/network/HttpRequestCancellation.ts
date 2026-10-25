import type { NodeStyleHttpServer } from "./HttpClientTypes.ts";
import { networkError } from "./errors.ts";

const REQUEST_MARKER_PREFIX = "x-signalbox-local-";
let requestMarkerSequence = 0n;

export interface RequestMarker {
  readonly name: string;
  readonly value: string;
}

interface RequestMessage {
  destroy(error?: Error): unknown;
  once(event: "close", listener: () => void): unknown;
}

interface RequestEventServer {
  prependListener(
    event: "request",
    listener: (incoming: RequestMessage, outgoing: RequestMessage) => void,
  ): unknown;
  removeListener(
    event: "request",
    listener: (incoming: RequestMessage, outgoing: RequestMessage) => void,
  ): unknown;
}

export function addRequestMarker(headers: Headers): RequestMarker {
  let name: string;
  do {
    name = `${REQUEST_MARKER_PREFIX}${requestMarkerSequence++}`;
  } while (headers.has(name));
  // @effect-diagnostics-next-line cryptoRandomUUID:off - request correlation is synchronous and runs before an Effect runtime exists.
  const marker = { name, value: globalThis.crypto.randomUUID() };
  headers.set(marker.name, marker.value);
  return marker;
}

function removeRequestMarker(incoming: RequestMessage, marker: RequestMarker): void {
  const headers = Reflect.get(incoming, "headers");
  // Materialize this public view before shortening rawHeaders; some handlers cache the original count.
  const headersDistinct = Reflect.get(incoming, "headersDistinct");
  if (
    typeof headers === "object" &&
    headers !== null &&
    Reflect.get(headers, marker.name) === marker.value
  ) {
    Reflect.deleteProperty(headers, marker.name);
  }

  const rawHeaders = Reflect.get(incoming, "rawHeaders");
  if (Array.isArray(rawHeaders)) {
    const filtered: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = rawHeaders[index];
      const value = rawHeaders[index + 1];
      if (
        typeof name === "string" &&
        typeof value === "string" &&
        name.toLowerCase() === marker.name &&
        value === marker.value
      ) {
        continue;
      }
      if (typeof name === "string" && typeof value === "string") filtered.push(name, value);
    }
    Reflect.set(incoming, "rawHeaders", filtered);
  }

  if (typeof headersDistinct === "object" && headersDistinct !== null) {
    const values = Reflect.get(headersDistinct, marker.name);
    if (Array.isArray(values)) {
      const remaining = values.filter((value) => value !== marker.value);
      if (remaining.length === 0) Reflect.deleteProperty(headersDistinct, marker.name);
      else Reflect.set(headersDistinct, marker.name, remaining);
    }
  }
}

/** Correlate cancellation with the matching Fetch request when HTTP dispatch is concurrent. */
export function attachRequestCancellation(
  server: NodeStyleHttpServer,
  request: Request,
  marker: RequestMarker,
): () => void {
  const eventServer = server as NodeStyleHttpServer & RequestEventServer;
  const captureRequest = (incoming: RequestMessage, outgoing: RequestMessage) => {
    const headers = Reflect.get(incoming, "headers");
    if (
      typeof headers !== "object" ||
      headers === null ||
      Reflect.get(headers, marker.name) !== marker.value
    ) {
      return;
    }
    eventServer.removeListener("request", captureRequest);
    removeRequestMarker(incoming, marker);
    const removeAbort = () => request.signal.removeEventListener("abort", abort);
    const abort = () => {
      const reset = networkError("ECONNRESET", "aborted");
      incoming.destroy(reset);
      outgoing.destroy(reset);
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    incoming.once("close", removeAbort);
    outgoing.once("close", removeAbort);
  };
  eventServer.prependListener("request", captureRequest);
  return () => eventServer.removeListener("request", captureRequest);
}

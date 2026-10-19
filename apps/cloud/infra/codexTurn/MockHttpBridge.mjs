import {
  HTTP_LIMITS,
  MockHttpWireError,
  decodeHttpUtf8,
  errorResponse,
  findHeaderEnd,
  parseRequestHead,
} from "./MockHttpWire.mjs";

const encoder = new TextEncoder();
const NO_BODY_STATUSES = new Set([204, 304]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STATUS_TEXT = new Map([
  [200, "OK"],
  [201, "Created"],
  [202, "Accepted"],
  [204, "No Content"],
  [206, "Partial Content"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [304, "Not Modified"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [408, "Request Timeout"],
  [413, "Payload Too Large"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
]);

function badRequest() {
  return new MockHttpWireError(400, "Bad Request");
}

/** Rebuilds an origin-form HTTP request without changing its path, headers, or body. */
export function requestFromHttpBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("HTTP request must be Uint8Array");
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) throw badRequest();

  const head = bytes.subarray(0, headerEnd);
  const metadata = parseRequestHead(head);
  const bodyStart = headerEnd + 4;
  if (bytes.byteLength !== bodyStart + metadata.contentLength) throw badRequest();
  if (!metadata.target.startsWith("/") || metadata.target.startsWith("//")) throw badRequest();

  const headers = new Headers();
  const lines = decodeHttpUtf8(head).split("\r\n").slice(1);
  try {
    for (const line of lines) {
      const colon = line.indexOf(":");
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    const body = bytes.slice(bodyStart);
    return new Request(new URL(metadata.target, "http://mock.invalid"), {
      method: metadata.method,
      headers,
      ...(body.byteLength === 0 ? {} : { body }),
    });
  } catch {
    throw badRequest();
  }
}

async function readBody(response, method) {
  if (method === "HEAD" || NO_BODY_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return new Uint8Array(0);
  }

  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > HTTP_LIMITS.responseBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function reasonPhrase(response) {
  const text = response.statusText || STATUS_TEXT.get(response.status) || "Response";
  return text.replace(/[\x00-\x1f\x7f]/g, " ").trim() || "Response";
}

/** Buffers a Fetch response and emits a bounded HTTP/1.1 response with valid framing. */
export async function responseToHttpBytes(response, method = "GET") {
  if (!(response instanceof Response)) throw new TypeError("HTTP handler must return a Response");
  const body = await readBody(response, method.toUpperCase());
  if (body === null) return errorResponse(502, "HTTP Response Too Large");

  const headers = [];
  for (const [name, value] of response.headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.push(`${name}: ${value}`);
  }
  if (!NO_BODY_STATUSES.has(response.status) && method.toUpperCase() !== "HEAD") {
    headers.push(`Content-Length: ${body.byteLength}`);
  }
  headers.push("Connection: close");

  const head = encoder.encode(
    [`HTTP/1.1 ${response.status} ${reasonPhrase(response)}`, ...headers, "", ""].join("\r\n"),
  );
  const output = new Uint8Array(head.byteLength + body.byteLength);
  output.set(head);
  output.set(body, head.byteLength);
  return output;
}

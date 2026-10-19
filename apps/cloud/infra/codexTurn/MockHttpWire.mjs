const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const HTTP_LIMITS = Object.freeze({
  headerBytes: 64 * 1024,
  headerCount: 1024,
  requestBodyBytes: 16 * 1024 * 1024,
  responseBodyBytes: 16 * 1024 * 1024,
});

export class MockHttpWireError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function badRequest(status = 400, reason = "Bad Request") {
  return new MockHttpWireError(status, reason);
}

export function decodeHttpUtf8(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw badRequest();
  }
}

export function findHeaderEnd(bytes) {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

export function parseRequestHead(bytes) {
  const text = decodeHttpUtf8(bytes);
  const lines = text.split("\r\n");
  const requestLine = lines.shift();
  const parts = requestLine && requestLine.split(" ");
  if (!parts || parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw badRequest();
  }

  const headers = new Map();
  let headerCount = 0;
  for (const line of lines) {
    if (line.length === 0 || line[0] === " " || line[0] === "\t") {
      throw badRequest();
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw badRequest();
    const rawName = line.slice(0, colon);
    if (rawName !== rawName.trim()) throw badRequest();
    const name = rawName.toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(name)) throw badRequest();
    const values = headers.get(name) ?? [];
    values.push(value);
    headers.set(name, values);
    if (++headerCount > HTTP_LIMITS.headerCount) {
      throw badRequest(431, "Request Header Fields Too Large");
    }
  }

  const hostValues = headers.get("host") ?? [];
  const lengthValues = headers.get("content-length") ?? [];
  if (hostValues.length !== 1 || lengthValues.length !== 1 || headers.has("transfer-encoding")) {
    throw badRequest();
  }

  const lengthText = lengthValues[0];
  if (!/^\d+$/.test(lengthText)) throw badRequest();
  const contentLength = Number(lengthText);
  if (!Number.isSafeInteger(contentLength)) throw badRequest();
  if (contentLength > HTTP_LIMITS.requestBodyBytes) {
    throw badRequest(413, "Payload Too Large");
  }

  return {
    method: parts[0],
    target: parts[1],
    version: parts[2],
    host: hostValues[0].toLowerCase(),
    contentLength,
  };
}

export function parseJsonRequestBody(bytes) {
  let body;
  try {
    body = JSON.parse(decodeHttpUtf8(bytes));
  } catch {
    throw badRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest();
  return body;
}

function buildResponse(status, reason, contentType, body, headers = []) {
  const lines = [
    "HTTP/1.1 " + status + " " + reason,
    "Content-Type: " + contentType,
    ...headers,
    "Connection: close",
    "Content-Length: " + body.byteLength,
    "",
    "",
  ];
  const head = encoder.encode(lines.join("\r\n"));
  const response = new Uint8Array(head.byteLength + body.byteLength);
  response.set(head);
  response.set(body, head.byteLength);
  return response;
}

export function errorResponse(status, reason) {
  return buildResponse(status, reason, "text/plain; charset=utf-8", encoder.encode(reason + "\n"));
}

export function sseResponse(sse) {
  const body = encoder.encode(sse);
  if (body.byteLength > HTTP_LIMITS.responseBodyBytes) {
    return errorResponse(502, "Mock Response Too Large");
  }
  return buildResponse(200, "OK", "text/event-stream", body, ["Cache-Control: no-cache"]);
}

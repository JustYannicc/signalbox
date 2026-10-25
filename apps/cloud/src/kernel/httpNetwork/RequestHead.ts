import type { HttpTarget } from "./Address.ts";
import { requestUrl } from "./Address.ts";
import { fail, hasHttpControls, NET_ERRNO } from "./Memory.ts";
import { HTTP_LIMITS } from "./Types.ts";

export interface HttpRequestHead {
  readonly method: string;
  readonly target: string;
  readonly host: string;
  readonly headers: Headers;
  readonly contentLength: number | undefined;
  readonly chunked: boolean;
}

const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function parseRequestHead(bytes: Uint8Array): HttpRequestHead {
  let text = "";
  for (let start = 0; start < bytes.length; start += 4096) {
    text += String.fromCharCode(...bytes.subarray(start, start + 4096));
  }
  const lines = text.split("\r\n");
  const parts = lines.shift()?.split(" ");
  if (parts?.length !== 3 || !parts[0] || !token.test(parts[0]) || !parts[1])
    fail(NET_ERRNO.NOTSUP);
  if (parts[2] !== "HTTP/1.1") fail(NET_ERRNO.NOTSUP);
  const method = parts[0];
  if (["CONNECT", "TRACE", "TRACK"].includes(method.toUpperCase())) fail(NET_ERRNO.NOTSUP);
  if (lines.length > HTTP_LIMITS.headerCount) fail(NET_ERRNO.MSGSIZE);
  const values = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0 || !token.test(line.slice(0, colon))) fail(NET_ERRNO.INVAL);
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (hasHttpControls(value)) fail(NET_ERRNO.INVAL);
    const previous = values.get(name) ?? [];
    previous.push(value);
    values.set(name, previous);
  }
  const hosts = values.get("host");
  const lengths = values.get("content-length");
  const transfers = values.get("transfer-encoding");
  if (
    hosts?.length !== 1 ||
    (lengths !== undefined && lengths.length !== 1) ||
    (transfers !== undefined && (transfers.length !== 1 || lengths !== undefined))
  )
    fail(NET_ERRNO.INVAL);
  if (values.has("upgrade") || values.has("expect") || values.has("trailer"))
    fail(NET_ERRNO.NOTSUP);
  const connection = (values.get("connection") ?? [])
    .join(",")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  if (connection.includes("upgrade")) fail(NET_ERRNO.NOTSUP);
  const chunked = transfers !== undefined;
  if (chunked && transfers[0]?.toLowerCase() !== "chunked") fail(NET_ERRNO.NOTSUP);
  let contentLength: number | undefined;
  if (lengths !== undefined) {
    const value = lengths[0]!;
    if (!/^[0-9]+$/.test(value)) fail(NET_ERRNO.INVAL);
    contentLength = Number(value);
    if (!Number.isSafeInteger(contentLength) || contentLength > HTTP_LIMITS.requestBodyBytes)
      fail(NET_ERRNO.MSGSIZE);
  }
  const headers = new Headers();
  const hop = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "transfer-encoding",
    "te",
    "trailer",
    ...connection,
  ]);
  for (const [name, entries] of values) {
    if (hop.has(name)) continue;
    for (const value of entries) headers.append(name, value);
  }
  return { method, target: parts[1], host: hosts[0]!, headers, contentLength, chunked };
}

export function buildRequest(
  head: HttpRequestHead,
  body: Uint8Array,
  connected: HttpTarget,
  tlsHostname: string | undefined,
  signal: AbortSignal,
): Request {
  if ((head.method === "GET" || head.method === "HEAD") && body.length !== 0)
    fail(NET_ERRNO.NOTSUP);
  const url = requestUrl(head.target, head.host, connected, tlsHostname);
  try {
    return new Request(url, {
      method: head.method,
      headers: head.headers,
      redirect: "manual",
      signal,
      ...(body.length === 0 ? {} : { body: body.slice().buffer }),
    });
  } catch {
    return fail(NET_ERRNO.NOTSUP);
  }
}

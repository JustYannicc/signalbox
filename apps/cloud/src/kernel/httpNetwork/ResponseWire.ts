import { fail, hasHttpControls, NET_ERRNO } from "./Memory.ts";
import { HTTP_LIMITS } from "./Types.ts";

const encoder = new TextEncoder();

export function abortable<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted)
    return Promise.reject(Object.assign(new Error("Network cancelled."), { code: "ECANCELED" }));
  return new Promise<A>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(Object.assign(new Error("Network cancelled."), { code: "ECANCELED" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function streamHttpResponse(
  response: Response,
  method: string,
  signal: AbortSignal,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const noBody = method === "HEAD" || [204, 205, 304].includes(response.status);
  const head = responseHead(response, noBody, method);
  await write(head);
  if (noBody) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    let cancellation: Promise<void> | undefined;
    const cancel = () => (cancellation ??= reader.cancel().catch(() => undefined));
    const onAbort = () => {
      void cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let complete = false;
    try {
      for (;;) {
        const next = await abortable(reader.read(), signal);
        if (next.done) {
          complete = true;
          break;
        }
        const bytes = next.value;
        if (!(bytes instanceof Uint8Array)) fail(NET_ERRNO.IO);
        if (bytes.length > HTTP_LIMITS.responseSourceChunkBytes) fail(NET_ERRNO.MSGSIZE);
        for (let start = 0; start < bytes.length; start += HTTP_LIMITS.responseFrameBytes) {
          const part = bytes.slice(start, start + HTTP_LIMITS.responseFrameBytes);
          await write(encoder.encode(`${part.length.toString(16)}\r\n`));
          await write(part);
          await write(encoder.encode("\r\n"));
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!complete || signal.aborted) await cancel();
      reader.releaseLock();
    }
  }
  await write(encoder.encode("0\r\n\r\n"));
}

function responseHead(response: Response, noBody: boolean, method: string): Uint8Array {
  if (response.status < 200 || response.status > 599 || /[^\x20-\x7e]/.test(response.statusText))
    fail(NET_ERRNO.NOTSUP);
  // Fetch can decompress while retaining this header. Refuse an ambiguous wire encoding.
  const encoding = response.headers.get("content-encoding");
  if (!noBody && encoding !== null && encoding.toLowerCase() !== "identity") fail(NET_ERRNO.NOTSUP);
  const connection = (response.headers.get("connection") ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  const hop = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "set-cookie",
    ...connection,
  ]);
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`];
  for (const [name, value] of response.headers) {
    if (hop.has(name)) continue;
    if (hasHttpControls(value)) fail(NET_ERRNO.INVAL);
    lines.push(`${name}: ${value}`);
  }
  for (const cookie of response.headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
  if (lines.length > HTTP_LIMITS.headerCount) fail(NET_ERRNO.MSGSIZE);
  const length = response.headers.get("content-length");
  if (noBody && (method === "HEAD" || response.status === 304) && length !== null) {
    if (!/^[0-9]+$/.test(length)) fail(NET_ERRNO.INVAL);
    lines.push(`content-length: ${length}`);
  }
  if (!noBody) lines.push("transfer-encoding: chunked");
  else if (response.status === 205) lines.push("content-length: 0");
  lines.push("connection: close", "", "");
  const bytes = encoder.encode(lines.join("\r\n"));
  if (bytes.length > HTTP_LIMITS.headerBytes) fail(NET_ERRNO.MSGSIZE);
  return bytes;
}

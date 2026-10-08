import { endToEnd } from "@signalbox/runner-protocol/PreviewTunnel";

import { PREVIEW_COOKIE, withoutCookie } from "./previewHost.ts";

/**
 * Headers across the gateway. The dev server sees a plain request to
 * `localhost:<port>` (Vite and friends refuse unknown hosts), without the
 * gateway's cookie or Cloudflare's headers; the browser sees the dev server's
 * answer at the preview origin.
 */

/** The WebSocket handshake is redone on the machine. */
const HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

const fromEdge = (name: string) =>
  name.startsWith("cf-") ||
  name.startsWith("x-forwarded-") ||
  name === "x-real-ip" ||
  name === "cdn-loop" ||
  name === "forwarded";

const localOrigin = (port: number) => `http://localhost:${port}`;

/** What the machine's dev server gets for a request to the preview at `origin`. */
export function requestHeaders(
  headers: Headers,
  input: { readonly origin: string; readonly port: number },
): Array<[string, string]> {
  const out: Array<[string, string]> = [["host", `localhost:${input.port}`]];
  for (const [name, value] of endToEnd(headers)) {
    if (name === "host" || HANDSHAKE.has(name) || fromEdge(name)) continue;
    if (name === "cookie") {
      const kept = withoutCookie(value, PREVIEW_COOKIE);
      if (kept !== null) out.push([name, kept]);
      continue;
    }
    if (name === "origin" && value === input.origin) {
      out.push([name, localOrigin(input.port)]);
      continue;
    }
    if (name === "referer" && value.startsWith(`${input.origin}/`)) {
      out.push([name, `${localOrigin(input.port)}${value.slice(input.origin.length)}`]);
      continue;
    }
    out.push([name, value]);
  }
  return out;
}

const LOCAL_ORIGINS = (port: number) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  `http://[::1]:${port}`,
  `http://0.0.0.0:${port}`,
];

/** Whether `setCookie` sets the gateway's own cookie. */
const setsGatewayCookie = (setCookie: string) =>
  setCookie.split("=", 1)[0]?.trim() === PREVIEW_COOKIE;

/** What the browser gets back from the dev server on `port`. */
export function responseHeaders(
  headers: ReadonlyArray<readonly [string, string]>,
  input: { readonly port: number },
): Headers {
  const out = new Headers();
  for (const [rawName, value] of endToEnd(headers)) {
    const name = rawName.toLowerCase();
    // The body is re-streamed, so its length is the runtime's to state.
    if (name === "content-length") continue;
    if (name === "set-cookie" && setsGatewayCookie(value)) continue;
    if (name === "location") {
      const local = LOCAL_ORIGINS(input.port).find(
        (origin) => value === origin || value.startsWith(`${origin}/`),
      );
      out.append(name, local === undefined ? value : value.slice(local.length) || "/");
      continue;
    }
    out.append(name, value);
  }
  return out;
}

/**
 * The close codes a socket may send. 1005 and 1006 only describe a close, and
 * the rest of the 1000s are the protocol's own.
 */
export const sendableCloseCode = (code: number) =>
  code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

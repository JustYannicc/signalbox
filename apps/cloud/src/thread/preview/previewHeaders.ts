import { endToEnd } from "@signalbox/runner-protocol/PreviewTunnel";

import { PREVIEW_COOKIE, PREVIEW_ROUTE_COOKIE } from "./previewHost.ts";

/**
 * Preview proxy policy adapted from Cloudflare VibeSDK's MIT-licensed proxy
 * (Copyright (c) 2025 Cloudflare; see `vibesdk-proxy.LICENSE`), pinned at
 * 9da158d82c597a0e8f4bf033cdccd1053fb6fb15:
 * https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/sandbox/request-handler.ts
 * https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/preview-headers.ts
 *
 * Each thread and port has its own HTTPS origin. The machine sees a plain
 * `localhost:<port>` request; only browser-facing headers needed by the app
 * cross that trust boundary.
 */

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "origin",
  "pragma",
  "range",
  "referer",
  "user-agent",
]);

const SERVICE_WORKER_SCOPE_HEADERS = new Set([
  "service-worker-allowed",
  "service-worker-navigation-preload",
  "clear-site-data",
]);

const localOrigin = (port: number) => `http://localhost:${port}`;

/** What the machine's dev server gets for a request to the preview at `origin`. */
export function requestHeaders(
  headers: Headers,
  input: { readonly origin: string; readonly port: number },
): Array<[string, string]> {
  const out: Array<[string, string]> = [["host", `localhost:${input.port}`]];
  for (const [name, value] of endToEnd(headers)) {
    if (name === "host" || !FORWARDED_REQUEST_HEADERS.has(name)) continue;
    if (name === "origin") {
      if (value === input.origin) out.push([name, localOrigin(input.port)]);
      continue;
    }
    if (name === "referer") {
      if (value === input.origin) {
        out.push([name, localOrigin(input.port)]);
      } else if (value.startsWith(`${input.origin}/`)) {
        out.push([name, `${localOrigin(input.port)}${value.slice(input.origin.length)}`]);
      }
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
  [PREVIEW_COOKIE, PREVIEW_ROUTE_COOKIE].includes(setCookie.split("=", 1)[0]?.trim() ?? "");

/** Domain cookies could cross the separate preview origins on sibling hosts. */
const previewScopedCookie = (setCookie: string) => {
  const [cookie, ...attributes] = setCookie.split(";");
  return [
    cookie,
    ...attributes.filter(
      (attribute) => attribute.trim().split("=", 1)[0]?.trim().toLowerCase() !== "domain",
    ),
  ].join(";");
};

/** What the browser gets back from the dev server on `port`. */
export function responseHeaders(
  headers: ReadonlyArray<readonly [string, string]>,
  input: { readonly port: number },
): Headers {
  const out = new Headers();

  for (const [rawName, value] of endToEnd(headers)) {
    const name = rawName.toLowerCase();
    // The body is re-streamed, so the runtime owns its length.
    if (name === "content-length" || SERVICE_WORKER_SCOPE_HEADERS.has(name)) continue;
    if (name === "set-cookie") {
      if (setsGatewayCookie(value)) continue;
      out.append(name, previewScopedCookie(value));
      continue;
    }
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

/** Close codes 1005 and 1006 only describe a close; other 1000s are reserved. */
export const sendableCloseCode = (code: number) =>
  code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

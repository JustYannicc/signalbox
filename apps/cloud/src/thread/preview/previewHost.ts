import type { ThreadId } from "@t3tools/contracts";
import * as Cookies from "effect/http/Cookies";

/**
 * Where previews live. Every (thread, port) gets an origin of its own,
 * `<label>.<PREVIEW_DOMAIN>`, because dev servers assume they own their
 * origin: absolute asset paths, HMR sockets, cookies, service workers. The
 * label is a hash of the thread and port: stable across machine generations
 * (so a preview's storage survives a wake) and DNS-safe for any thread id.
 * It's no secret; access is the cookie's job.
 *
 * `PREVIEW_DOMAIN` is a hostname with an optional port. Production wants a
 * registrable domain of its own (like githubusercontent.com), so preview pages
 * aren't same-site with the app; `wrangler dev` uses `localhost:8787`, whose
 * subdomains browsers resolve to loopback. Unset, previews are off.
 */

export interface PreviewEnv {
  /** e.g. `signalbox-preview.run`, or `localhost:8787` under `wrangler dev`. */
  readonly PREVIEW_DOMAIN?: string;
  readonly LOCAL_WORKERD?: string;
}

export interface PreviewSettings {
  /** Hostname and optional port, lower case. */
  readonly domain: string;
  readonly hostname: string;
  readonly scheme: "https" | "http";
}

/** The cookie a preview origin keeps its session in. Never forwarded to the dev server. */
export const PREVIEW_COOKIE = "signalbox_preview";
/** Where a preview link lands: trades `?ticket=` for the session cookie. */
export const PREVIEW_TICKET_PATH = "/__signalbox/preview";

const LABEL_LENGTH = 26;
const LABEL_PATTERN = /^[a-z2-7]{26}$/;

export function previewSettings(env: PreviewEnv): PreviewSettings | null {
  const domain = env.PREVIEW_DOMAIN?.trim().toLowerCase();
  if (domain === undefined || domain === "") return null;
  return {
    domain,
    hostname: domain.replace(/:\d+$/, ""),
    // Local workerd serves plain HTTP; anything deployed is HTTPS.
    scheme: env.LOCAL_WORKERD === "1" ? "http" : "https",
  };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const base32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
};

/** The DNS label of `threadId`'s preview of `port`. */
export async function previewLabel(threadId: ThreadId, port: number): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`signalbox-preview\n${threadId}\n${port}`),
  );
  return base32(new Uint8Array(digest)).slice(0, LABEL_LENGTH);
}

/** The label when `hostname` is a preview host under `settings`, else null. */
export function labelOfHost(settings: PreviewSettings, hostname: string): string | null {
  const suffix = `.${settings.hostname}`;
  const host = hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return LABEL_PATTERN.test(label) ? label : null;
}

export const previewOrigin = (settings: PreviewSettings, label: string) =>
  `${settings.scheme}://${label}.${settings.domain}`;

/** A cookie's value from a `Cookie` header. */
export const readCookie = (header: string | null, name: string): string | null =>
  header === null ? null : (Cookies.parseHeader(header)[name] ?? null);

/** `header` without cookie `name`, or null when nothing is left. */
export function withoutCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  const kept = header
    .split(";")
    .filter((part) => {
      const index = part.indexOf("=");
      return part.trim() !== "" && (index === -1 || part.slice(0, index).trim() !== name);
    })
    .map((part) => part.trim());
  return kept.length === 0 ? null : kept.join("; ");
}

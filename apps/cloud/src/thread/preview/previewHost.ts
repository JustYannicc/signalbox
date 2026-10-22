import * as Cookies from "effect/http/Cookies";

/**
 * Where previews live. Every (thread, port) gets an origin of its own, the
 * label in place of `PREVIEW_DOMAIN`'s `*`, because dev servers assume they own their
 * origin: absolute asset paths, HMR sockets, cookies, service workers. The
 * label is a hash of the thread and port: stable across machine generations
 * (so a preview's storage survives a wake) and DNS-safe for any thread id.
 * It's no secret; access is the cookie's job.
 *
 * `PREVIEW_DOMAIN` is the preview host with `*` for the label, in route
 * pattern syntax, and an optional port: `*-pr12.signalbox-preview.dev`. A
 * plain domain means `*.<domain>`. Deployments want a registrable domain of
 * their own (like githubusercontent.com), so preview pages aren't same-site
 * with the app, and share it by what follows the label: Universal SSL covers
 * only one level of subdomains. `wrangler dev` uses `localhost:8787`, whose
 * subdomains browsers resolve to loopback. Unset, previews are off.
 */

export interface PreviewEnv {
  /** e.g. `*-app.signalbox-preview.dev`, or `localhost:8787` under `wrangler dev`. */
  readonly PREVIEW_DOMAIN?: string;
  readonly LOCAL_WORKERD?: string;
}

export interface PreviewSettings {
  /** What follows the label in a preview origin, port included, lower case. */
  readonly suffix: string;
  /** `suffix` without the port: what a preview request's hostname ends with. */
  readonly hostSuffix: string;
  readonly scheme: "https" | "http";
}

/** The cookie a preview origin keeps its session in. Never forwarded to the dev server. */
export const PREVIEW_COOKIE = "signalbox_preview";
/** Where a preview link lands: trades `?ticket=` for the session cookie. */
export const PREVIEW_TICKET_PATH = "/__signalbox/preview";

const LABEL_PATTERN = /^[a-z2-7]{26}$/;

export function previewSettings(env: PreviewEnv): PreviewSettings | null {
  const domain = env.PREVIEW_DOMAIN?.trim().toLowerCase();
  if (domain === undefined || domain === "") return null;
  const suffix = domain.startsWith("*") ? domain.slice(1) : `.${domain}`;
  // The label must end at a separator, or the pattern would claim every host.
  if (!/^[.-][a-z0-9]/.test(suffix)) return null;
  return {
    suffix,
    hostSuffix: suffix.replace(/:\d+$/, ""),
    // Local workerd serves plain HTTP; anything deployed is HTTPS.
    scheme: env.LOCAL_WORKERD === "1" ? "http" : "https",
  };
}

/** The label when `hostname` is a preview host under `settings`, else null. */
export function labelOfHost(settings: PreviewSettings, hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(settings.hostSuffix)) return null;
  const label = host.slice(0, -settings.hostSuffix.length);
  return LABEL_PATTERN.test(label) ? label : null;
}

/** Whether `hostname` is under the preview domain, as a label or not. Such hosts never get the app. */
export const isPreviewHost = (settings: PreviewSettings, hostname: string) =>
  hostname.toLowerCase().endsWith(settings.hostSuffix);

export const previewOrigin = (settings: PreviewSettings, label: string) =>
  `${settings.scheme}://${label}${settings.suffix}`;

/** A cookie's value from a `Cookie` header. */
export const readCookie = (header: string | null, name: string): string | null =>
  header === null ? null : (Cookies.parseHeader(header)[name] ?? null);

/** Reserved for credentials issued before missing previews began returning 404. */
export const PREVIEW_ROUTE_COOKIE = "signalbox_preview_route";

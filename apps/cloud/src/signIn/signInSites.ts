import { SIGN_IN_EVERYWHERE } from "@t3tools/contracts/signalboxSignIn";
import { normalizeHostname } from "@t3tools/shared/hostClassification";
import { parse } from "tldts";

/**
 * What a sign-in grant's site covers, decided without storage (#575). A site
 * is a host and covers every host below it, the way 1Password matches a
 * login's website: `booking.com` covers `account.booking.com`, never
 * `booking.com.evil.test`. An IP address covers only itself.
 */

/** A hostname's labels, after URL parsing made it lowercase punycode. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Private suffixes (`github.io`) count: each project under one is its own site. */
const parseHost = (host: string) => parse(host, { allowPrivateDomains: true });

/**
 * The host of a page or site, or null for anything that isn't an http(s)
 * address of a real host. A bare `example.com` reads as `https://example.com`.
 */
export const hostOf = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = normalizeHostname(url.hostname);
  if (parseHost(host).isIp) return host;
  return HOSTNAME.test(host) ? host : null;
};

/**
 * The site a grant keeps for what the person typed: `*`, or the host, with
 * `www.` dropped because it names the site itself. Null when it isn't one
 * site: a public suffix (`co.uk`, `github.io`), a single label, a wildcard.
 */
export const grantSiteOf = (input: string): string | null => {
  if (input.trim() === SIGN_IN_EVERYWHERE) return SIGN_IN_EVERYWHERE;
  const host = hostOf(input);
  if (host === null) return null;
  const parsed = parseHost(host);
  if (parsed.isIp) return host;
  if (parsed.domain === null) return null;
  return host.startsWith("www.") && host !== `www.${parsed.publicSuffix}` ? host.slice(4) : host;
};

/**
 * The site a needs-you offers for `host`: the address its accounts usually
 * share. Null for a host that is no one site (`localhost`, a bare suffix),
 * which no grant could cover either.
 */
export const askSiteOf = (host: string): string | null => {
  const parsed = parseHost(host);
  return parsed.isIp ? host : parsed.domain;
};

const covers = (site: string, host: string) =>
  site === SIGN_IN_EVERYWHERE ||
  host === site ||
  (host.endsWith(`.${site}`) && !parseHost(site).isIp);

/**
 * The narrowest grant covering `host`, or null: an exact host over its
 * parent domains, over everywhere. Naming the narrowest makes clear which
 * grant to revoke.
 */
export const narrowestCovering = <G extends { readonly site: string }>(
  grants: ReadonlyArray<G>,
  host: string,
): G | null => {
  let best: G | null = null;
  for (const grant of grants) {
    if (!covers(grant.site, host)) continue;
    const length = grant.site === SIGN_IN_EVERYWHERE ? -1 : grant.site.length;
    const bestLength =
      best === null ? -2 : best.site === SIGN_IN_EVERYWHERE ? -1 : best.site.length;
    if (length > bestLength) best = grant;
  }
  return best;
};

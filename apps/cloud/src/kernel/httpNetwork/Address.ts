import { fail, NET_ERRNO } from "./Memory.ts";

export interface HttpTarget {
  readonly hostname: string;
  readonly port: number;
}

export function hostname(value: string): string {
  if (value.length === 0 || value.length > 253 || /[\s\\/@?#%]/.test(value)) fail(NET_ERRNO.INVAL);
  if (!/^(?:[A-Za-z0-9_.-]+|\[[0-9a-fA-F:.]+\])$/.test(value)) fail(NET_ERRNO.INVAL);
  try {
    const url = new URL(`http://${value}/`);
    if (url.hostname.toLowerCase() !== value.toLowerCase() || url.port !== "")
      fail(NET_ERRNO.INVAL);
    return value;
  } catch {
    return fail(NET_ERRNO.INVAL);
  }
}

export function port(value: string): number {
  if (!/^[0-9]{1,5}$/.test(value)) fail(NET_ERRNO.INVAL);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) fail(NET_ERRNO.INVAL);
  return parsed;
}

export function parseAddress(value: string): HttpTarget {
  const split = value.lastIndexOf(":");
  if (split < 1) fail(NET_ERRNO.INVAL);
  return { hostname: hostname(value.slice(0, split)), port: port(value.slice(split + 1)) };
}

export function sameHostname(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function requestUrl(
  target: string,
  host: string,
  connected: HttpTarget,
  tlsHostname: string | undefined,
): URL {
  if (/[#\\]|[^\x21-\x7e]/.test(target)) fail(NET_ERRNO.INVAL);
  const scheme = tlsHostname === undefined ? "http:" : "https:";
  const authority = `${tlsHostname ?? connected.hostname}:${connected.port}`;
  let url: URL;
  try {
    if (target.startsWith("/")) {
      url = new URL(`${scheme}//${authority}${target}`);
    } else if (/^https?:\/\//i.test(target)) {
      url = new URL(target);
    } else return fail(NET_ERRNO.NOTSUP);
    const hostUrl = new URL(`${scheme}//${host}/`);
    const expectedPort = String(connected.port);
    const resolvedPort = (value: URL) => value.port || (value.protocol === "https:" ? "443" : "80");
    if (
      url.protocol !== scheme ||
      url.username ||
      url.password ||
      url.hash ||
      !sameHostname(url.hostname, connected.hostname) ||
      resolvedPort(url) !== expectedPort ||
      hostUrl.username ||
      hostUrl.password ||
      hostUrl.pathname !== "/" ||
      hostUrl.search ||
      hostUrl.hash ||
      !sameHostname(hostUrl.hostname, connected.hostname) ||
      resolvedPort(hostUrl) !== expectedPort ||
      /[\s\\/@?#%]/.test(host)
    )
      fail(NET_ERRNO.INVAL);
    return url;
  } catch {
    return fail(NET_ERRNO.INVAL);
  }
}

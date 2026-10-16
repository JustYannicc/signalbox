import { isPrivateNetworkHost, normalizeHostname } from "@t3tools/shared/hostClassification";

/**
 * Which browser a URL opens in (#574), decided in code so the agent never
 * names one. `machine` is the thread's headless browser, with no cookies:
 * its dev servers, anything on the machine's network, and local documents.
 * `person` is the person's Kernel browser, signed in with their profile.
 * Anything that can't be read as a URL stays on the machine, so a typo
 * never carries the profile anywhere.
 */
export type BrowserRoute = "machine" | "person";

const LOCAL_SCHEMES = new Set(["about:", "data:", "file:", "blob:"]);

export const browserFor = (url: string): BrowserRoute => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "machine";
  }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return "machine";
  const host = normalizeHostname(parsed.hostname);
  // `.internal` names the machine's own network, as `host.docker.internal` does.
  if (host === "" || host.endsWith(".internal") || isPrivateNetworkHost(host)) return "machine";
  return "person";
};

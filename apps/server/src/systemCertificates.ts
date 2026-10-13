import * as NodeTls from "node:tls";

/**
 * Trusts the OS certificate store alongside Node's bundled CAs, the way
 * browsers and curl do. Self-hosted services (a CLIProxyAPI behind an internal
 * CA, a company proxy) otherwise fail TLS in the server even though they open
 * fine everywhere else. Older Node versions without the API keep the bundle.
 */
export function trustSystemCertificates(): void {
  if (typeof NodeTls.setDefaultCACertificates !== "function") return;
  try {
    const system = NodeTls.getCACertificates("system");
    if (system.length === 0) return;
    NodeTls.setDefaultCACertificates([
      ...new Set([...NodeTls.getCACertificates("default"), ...system]),
    ]);
  } catch {
    // An unreadable OS store leaves Node's bundle in place.
  }
}

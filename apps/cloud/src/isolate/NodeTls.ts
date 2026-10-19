// @effect-diagnostics nodeBuiltinImport:off - TLS connections and peer validation remain native.
import * as NodeTls from "node:tls";
import bundledRoots from "./node/tls/bundledRoots.json" with { type: "json" };

const fallbackRoots = Object.freeze(bundledRoots.certificates);

export function nodeRootCertificates(native = NodeTls.rootCertificates) {
  // Node's bundled Mozilla snapshot is separate from the active TLS trust store.
  // Workerd exposes no bundled metadata; its handshake validation stays native.
  return native.length ? Object.freeze([...native]) : fallbackRoots;
}

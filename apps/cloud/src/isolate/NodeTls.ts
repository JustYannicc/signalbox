// @effect-diagnostics nodeBuiltinImport:off - TLS connections and peer validation remain native.
import * as NodeTls from "node:tls";
import { copyNativeExports } from "./node/network/moduleExports.ts";
import bundledRoots from "./node/tls/bundledRoots.json" with { type: "json" };

const fallbackRoots = Object.freeze(bundledRoots.certificates);

export function nodeRootCertificates(native = NodeTls.rootCertificates) {
  // Node's bundled Mozilla snapshot is separate from the active TLS trust store.
  // Workerd exposes no bundled metadata; its handshake validation stays native.
  return native.length ? Object.freeze([...native]) : fallbackRoots;
}

/** Native TLS with Node's root metadata. Callers that check the bundled list before trusting
 * the runtime, like Claude Code's CA deny-list guard, refuse to start when it's empty. */
export function nodeTlsModule(native: object = NodeTls) {
  const module = copyNativeExports(Reflect.get(native, "default") ?? native);
  const roots = module.rootCertificates;
  module.rootCertificates = nodeRootCertificates(Array.isArray(roots) ? roots : []);
  return module;
}

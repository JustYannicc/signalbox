// @effect-diagnostics nodeBuiltinImport:off - TLS connections and peer validation remain native.
import * as NodeTls from "node:tls";
import bundledRoots from "./node/tls/bundledRoots.json" with { type: "json" };

const fallbackRoots = Object.freeze(bundledRoots.certificates);

export function nodeRootCertificates(native = NodeTls.rootCertificates) {
  // Node's bundled Mozilla snapshot is separate from the active TLS trust store.
  // Workerd exposes no bundled metadata; its handshake validation stays native.
  return native.length ? Object.freeze([...native]) : fallbackRoots;
}

/** Native TLS, with Node's bundled root metadata when the runtime has none. Some CLIs filter
 * that list before trusting the runtime and refuse to start when it comes back empty. */
export function nodeTlsModule(native: object = NodeTls): object {
  const module: object = Reflect.get(native, "default") ?? native;
  const roots: unknown = Reflect.get(module, "rootCertificates");
  if (Array.isArray(roots) && roots.length > 0) return module;
  const fallback = nodeRootCertificates([]);
  // Everything else stays the native module itself, so guest settings and identities still apply.
  return new Proxy(module, {
    get: (target, key) => (key === "rootCertificates" ? fallback : Reflect.get(target, key)),
    // Descriptor-copying re-exports must see the fallback too, where proxy invariants allow it.
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "rootCertificates" || descriptor === undefined || !("value" in descriptor))
        return descriptor;
      if (!descriptor.configurable && !descriptor.writable) return descriptor;
      return { ...descriptor, value: fallback };
    },
  });
}

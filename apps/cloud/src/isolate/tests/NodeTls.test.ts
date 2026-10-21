// @effect-diagnostics nodeBuiltinImport:off - Validate real certificates with Node's native X509 implementation.
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import { describe, expect, it } from "@effect/vitest";
import { nodeRootCertificates, nodeTlsModule } from "../NodeTls.ts";

describe("Node TLS bundled roots", () => {
  it("supplies parseable CA certificates when the runtime has no bundled metadata", () => {
    const native: string[] = [];
    const roots = nodeRootCertificates(native);
    expect(roots.length).toBeGreaterThan(0);
    const certificates = roots.map((pem) => new NodeCrypto.X509Certificate(pem));
    expect(certificates.every((certificate) => certificate.ca)).toBe(true);
    const fingerprints = certificates.map((certificate) =>
      NodeCrypto.createHash("sha256").update(certificate.raw).digest("hex"),
    );
    expect(fingerprints).toHaveLength(120);
    expect(NodeCrypto.createHash("sha256").update(fingerprints.join("\n")).digest("hex")).toBe(
      "3d40b93910ed74fa29cf0d0e1604642a8e3b1cfc22a8d70bfef5ac24cea005c1",
    );
    expect(new Set(fingerprints).size).toBe(certificates.length);
    expect(native).toEqual([]);
    expect(Object.isFrozen(roots)).toBe(true);
  });

  it("keeps a runtime's existing roots and protects the snapshot from caller mutation", () => {
    const first = NodeTls.rootCertificates[0]!;
    const native = [first];
    const roots = nodeRootCertificates(native);
    expect(roots).toEqual([first]);
    native.length = 0;
    expect(roots).toEqual([first]);
    expect(Object.isFrozen(roots)).toBe(true);
  });

  it("returns native TLS itself when the runtime already has roots", () => {
    const native = { rootCertificates: [NodeTls.rootCertificates[0]!], connect() {} };
    expect(nodeTlsModule(native)).toBe(native);
    expect(nodeTlsModule({ default: native })).toBe(native);
  });

  it("adds only the bundled roots when native TLS has none", () => {
    const connect = () => "native socket";
    const native = { rootCertificates: [] as string[], DEFAULT_MIN_VERSION: "TLSv1.2", connect };
    const module = nodeTlsModule({ default: native });
    expect(Reflect.get(module, "rootCertificates")).toBe(nodeRootCertificates([]));
    expect(Reflect.get(module, "connect")).toBe(connect);
    Reflect.set(module, "DEFAULT_MIN_VERSION", "TLSv1.3");
    expect(native.DEFAULT_MIN_VERSION).toBe("TLSv1.3");
    expect(native.rootCertificates).toEqual([]);
    const clone = Object.create(null, Object.getOwnPropertyDescriptors(module));
    expect(clone.rootCertificates).toBe(nodeRootCertificates([]));
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Validate real certificates with Node's native X509 implementation.
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import { describe, expect, it } from "@effect/vitest";
import { createNodeTls } from "../NodeTls.ts";
import { createNodeBridge } from "../NodeBridge.ts";

describe("Node TLS bundled roots", () => {
  it("supplies parseable CA certificates when the runtime has no bundled metadata", () => {
    const native = { ...NodeTls, rootCertificates: [] };
    const tls = createNodeTls(native);
    expect(tls.rootCertificates.length).toBeGreaterThan(0);
    const certificates = tls.rootCertificates.map((pem) => new NodeCrypto.X509Certificate(pem));
    expect(certificates.every((certificate) => certificate.ca)).toBe(true);
    const fingerprints = certificates.map((certificate) =>
      NodeCrypto.createHash("sha256").update(certificate.raw).digest("hex"),
    );
    expect(fingerprints).toHaveLength(120);
    expect(NodeCrypto.createHash("sha256").update(fingerprints.join("\n")).digest("hex")).toBe(
      "3d40b93910ed74fa29cf0d0e1604642a8e3b1cfc22a8d70bfef5ac24cea005c1",
    );
    expect(new Set(fingerprints).size).toBe(certificates.length);
    expect(native.rootCertificates).toEqual([]);
    expect(Object.isFrozen(tls.rootCertificates)).toBe(true);
  });

  it("keeps a runtime's existing roots and protects the snapshot from caller mutation", () => {
    const first = NodeTls.rootCertificates[0]!;
    const roots = [first];
    const tls = createNodeTls({ ...NodeTls, rootCertificates: roots });
    expect(tls.rootCertificates).toEqual([first]);
    roots.length = 0;
    expect(tls.rootCertificates).toEqual([first]);
    expect(Object.isFrozen(tls.rootCertificates)).toBe(true);
  });

  it("preserves native trust queries, connection functions and hostname validation", () => {
    const tls = createNodeTls();
    expect(tls.getCACertificates).toBe(NodeTls.getCACertificates);
    expect(tls.getCACertificates()).toEqual(NodeTls.getCACertificates());
    expect(tls.connect).toBe(NodeTls.connect);
    expect(tls.createSecureContext).toBe(NodeTls.createSecureContext);
    expect(tls.checkServerIdentity).toBe(NodeTls.checkServerIdentity);
    expect(tls.TLSSocket).toBe(NodeTls.TLSSocket);
    const certificate = new NodeCrypto.X509Certificate(
      NodeTls.rootCertificates[0]!,
    ).toLegacyObject();
    expect(tls.checkServerIdentity("wrong.example", certificate)).toBeInstanceOf(Error);
  });

  it("exposes one module for bare and node-prefixed imports without modifying native exports", () => {
    const nativeRoots = NodeTls.rootCertificates;
    const tls = createNodeTls();
    const bridge = createNodeBridge({ tls });
    expect(bridge.require("tls")).toBe(tls);
    expect(bridge.require("node:tls")).toBe(tls);
    expect(tls.default).toBe(tls);
    expect(Object.isFrozen(tls)).toBe(true);
    expect(NodeTls.rootCertificates).toBe(nativeRoots);
  });
});

// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Isolated Workerd integration fixture.
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it("rejects ignored native options while preserving fetch clients, context propagation and cancellation", async () => {
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "node-native-option-guards",
          main: NodeURL.fileURLToPath(
            new URL("./tests/nativeOptionGuards.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const options = await harness.fetch("http://proof/options");
    const body = await options.text();
    expect(options.status, body).toBe(200);
    const rows = JSON.parse(body);
    expect(rows).toHaveLength(12);
    for (const row of rows)
      expect(row.code, row.path).toBe("ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED");
    const tls = await harness.fetch("http://proof/tls");
    const tlsBody = await tls.text();
    expect(tls.status, tlsBody).toBe(200);
    expect(JSON.parse(tlsBody)).toEqual({
      codes: Array(64).fill("ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED"),
      identities: [true, true],
      servernames: ["fixture.test", "fixture.test"],
    });
    const client = await harness.fetch("http://proof/client");
    expect(await client.json()).toEqual({
      observed: [{ url: "https://model.test:8443/messages", method: "POST", body: "request body" }],
      body: "fetch-backed response",
    });
    const resource = await harness.fetch("http://proof/async-resource");
    expect(await resource.json()).toEqual({
      value: "captured:bound",
      scoped: "captured",
      staticValue: "static",
      errors: Array(7).fill("ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED"),
      status: "conditional",
    });
    const timer = await harness.fetch("http://proof/timers");
    expect(await timer.json()).toEqual({
      results: ["ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED", "ABORT_ERR"],
    });
    const jwk = await harness.fetch("http://proof/rsa-jwk");
    const jwkBody = await jwk.text();
    expect(jwk.status, jwkBody).toBe(200);
    const roots = JSON.parse(jwkBody);
    expect(roots.rsa).toBeGreaterThan(0);
    expect(roots).toEqual({ rsa: roots.rsa, matched: roots.rsa, failures: [] });
    const rsa = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaJwk = await harness.fetch("http://proof/rsa-jwk-keys", {
      method: "POST",
      body: JSON.stringify({
        privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
        publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }),
      }),
    });
    const rsaJwkBody = await rsaJwk.text();
    expect(rsaJwk.status, rsaJwkBody).toBe(200);
    // Node's own JWK export is the contract.
    expect(JSON.parse(rsaJwkBody)).toEqual({
      publicKey: rsa.publicKey.export({ format: "jwk" }),
      privateKey: rsa.privateKey.export({ format: "jwk" }),
    });
    const crypto = await harness.fetch("http://proof/crypto-zlib");
    const cryptoBody = await crypto.text();
    expect(crypto.status, cryptoBody).toBe(200);
    expect(JSON.parse(cryptoBody)).toEqual({
      verified: true,
      certificateAuthority: true,
      inflated: "guest bytes\n",
      deflated: "guest bytes\n",
      streams: Array(5).fill("guest bytes\n"),
    });
    const dsa = NodeCrypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 160 });
    const unsupported = await harness.fetch("http://proof/dsa", {
      method: "POST",
      body: JSON.stringify({
        privateKey: dsa.privateKey.export({ type: "pkcs8", format: "pem" }),
        publicKey: dsa.publicKey.export({ type: "spki", format: "pem" }),
      }),
    });
    const unsupportedBody = await unsupported.text();
    expect(unsupported.status, unsupportedBody).toBe(200);
    expect(JSON.parse(unsupportedBody)).toEqual({
      codes: Array(4).fill("ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED"),
    });
  } finally {
    await harness.close();
  }
});

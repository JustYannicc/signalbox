import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";

const expiry = "2026-10-31T14:00:00.000Z";
const base = {
  accountId: "a".repeat(32),
  authorityToken: "offline-token",
  tokenId: "b".repeat(32),
  expectedExpiresOn: expiry,
  nowMs: Date.parse(expiry) - 1_000,
  mode: "self" as const,
};
const response = (result: unknown) => Response.json({ success: true, result });

NodeTest.test(
  "verifies a future expiry through the actual self endpoint without claiming expired",
  async () => {
    const result = await verifyDeploy3TokenExpiry({
      ...base,
      fetchImpl: async (url) => {
        NodeAssert.equal(
          String(url),
          `https://api.cloudflare.com/client/v4/accounts/${base.accountId}/tokens/verify`,
        );
        return response({ id: base.tokenId, status: "active", expires_on: expiry });
      },
    });
    NodeAssert.deepEqual(result, { status: "expiry-configured", expiresOn: expiry });
  },
);

NodeTest.test(
  "requires an authoritative matching expired record before claiming expired",
  async () => {
    const result = await verifyDeploy3TokenExpiry({
      ...base,
      mode: "account-record",
      nowMs: Date.parse(expiry),
      fetchImpl: async (url) => {
        NodeAssert.equal(String(url).endsWith(`/tokens/${base.tokenId}`), true);
        return response({ id: base.tokenId, status: "expired", expires_on: expiry });
      },
    });
    NodeAssert.equal(result.status, "expired-verified");
  },
);

NodeTest.test(
  "a denial, missing expiry, wrong ID, changed expiry or active expired token never proves expiry",
  async () => {
    for (const result of [
      { id: "c".repeat(32), status: "active", expires_on: expiry },
      { id: base.tokenId, status: "active" },
      { id: base.tokenId, status: "active", expires_on: "2026-11-01T14:00:00.000Z" },
      { id: base.tokenId, status: "active", expires_on: expiry },
    ]) {
      const observed = await verifyDeploy3TokenExpiry({
        ...base,
        nowMs: Date.parse(expiry) + 1_000,
        fetchImpl: async () => response(result),
      });
      NodeAssert.equal(observed.status, "unverified");
    }
    const denied = await verifyDeploy3TokenExpiry({
      ...base,
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    NodeAssert.equal(denied.status, "unverified");
  },
);

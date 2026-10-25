import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "@effect/vitest";

import { executorSigningJwk } from "./executorSigningKey.ts";

describe("Executor signing key derivation", () => {
  it("derives a stable P-256 key pair from the deployment seed", async () => {
    const serialized = executorSigningJwk("17".repeat(32));
    const privateJwk = JSON.parse(serialized) as JWK;
    const { d: _privatePart, ...publicJwk } = privateJwk;
    const privateKey = await importJWK(privateJwk, "ES256");
    const publicKey = await importJWK(publicJwk, "ES256");
    const token = await new SignJWT({ owner: "org_acme" })
      .setProtectedHeader({ alg: "ES256" })
      .sign(privateKey);

    expect(executorSigningJwk("17".repeat(32))).toBe(serialized);
    await expect(jwtVerify(token, publicKey)).resolves.toMatchObject({
      payload: { owner: "org_acme" },
    });
  });

  it("rejects a seed that is not 32 bytes", () => {
    expect(() => executorSigningJwk("abcd")).toThrow("Executor signing seed must be 32 bytes.");
  });
});

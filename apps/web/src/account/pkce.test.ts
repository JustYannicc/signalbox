import { describe, expect, it } from "vite-plus/test";

import { createPkceVerifier, pkceChallenge } from "./pkce";

describe("pkce", () => {
  it("produces the RFC 7636 S256 challenge", async () => {
    // RFC 7636 appendix B.
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates fresh 43-character base64url verifiers", () => {
    const verifier = createPkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createPkceVerifier()).not.toBe(verifier);
  });
});

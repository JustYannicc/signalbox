/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { buildAccountAuthorizeUrl, parseAccountReturn } from "@t3tools/client-runtime/account";
import { describe, expect, it } from "vite-plus/test";

import { SIGNALBOX_APP_URL } from "@t3tools/shared/signalboxAppUrl";

import {
  accountReturnUrl,
  createPkcePair,
  pkceChallenge,
  signInFailureCopy,
  socialProviders,
  type PkceCrypto,
} from "./signInLogic";

const nodeCrypto: PkceCrypto = {
  randomBytes: (byteCount) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  sha256: (data) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
};

describe("sign-in server", () => {
  // The server builds its own redirect URIs from `origin` and rejects one with a path.
  it("is Signalbox Cloud's bare origin, which the authorize URL is built from", () => {
    const url = new URL(
      buildAccountAuthorizeUrl({
        provider: "github",
        mode: "native",
        origin: SIGNALBOX_APP_URL,
        returnUrl: "signalbox://account-return",
        challenge: "abc",
      }),
    );
    expect(url.origin).toBe(SIGNALBOX_APP_URL);
    expect(url.pathname).toBe("/api/account/authorize");
    expect(url.searchParams.get("origin")).toBe(SIGNALBOX_APP_URL);
  });
});

describe("accountReturnUrl", () => {
  it("uses the build's own scheme", () => {
    expect(accountReturnUrl("signalbox")).toBe("signalbox://account-return");
    expect(accountReturnUrl("signalbox-dev")).toBe("signalbox-dev://account-return");
    expect(accountReturnUrl(["t3code", "signalbox-preview"])).toBe(
      "signalbox-preview://account-return",
    );
  });

  it("refuses schemes the server will not hand off to", () => {
    expect(accountReturnUrl("exp")).toBeNull();
    expect(accountReturnUrl(undefined)).toBeNull();
  });

  it("round-trips the server's handoff and error redirects", () => {
    const returnUrl = accountReturnUrl("signalbox-dev")!;
    expect(parseAccountReturn(`${returnUrl}?handoff=h_123`)).toEqual({
      _tag: "handoff",
      handoff: "h_123",
    });
    expect(parseAccountReturn(`${returnUrl}?error=expired`)).toEqual({
      _tag: "error",
      error: "expired",
    });
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 S256 example", async () => {
    await expect(
      pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", nodeCrypto),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates an unpadded base64url verifier bound to its challenge", async () => {
    const pair = await createPkcePair(nodeCrypto);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(pkceChallenge(pair.verifier, nodeCrypto)).resolves.toBe(pair.challenge);
  });
});

describe("socialProviders", () => {
  it("keeps contract order and leaves email to its own field", () => {
    expect(socialProviders(["email", "apple", "google"])).toEqual(["google", "apple"]);
    expect(socialProviders(["email"])).toEqual([]);
  });
});

describe("signInFailureCopy", () => {
  it("stays quiet when the user backed out", () => {
    expect(signInFailureCopy("cancelled")).toBeNull();
  });

  it("has plain copy for every other error", () => {
    expect(signInFailureCopy("expired")).toBe("Sign-in took too long. Try again.");
    expect(signInFailureCopy("failed")).toBe("Sign-in didn't go through. Try again.");
  });
});

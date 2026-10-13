/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { buildAccountAuthorizeUrl, parseAccountReturn } from "@t3tools/client-runtime/account";
import { describe, expect, it } from "vite-plus/test";

import {
  accountReturnUrl,
  createPkcePair,
  normalizeServerUrl,
  pkceChallenge,
  serverDisplayHost,
  signInFailureCopy,
  socialProviders,
  type PkceCrypto,
} from "./signInLogic";

const nodeCrypto: PkceCrypto = {
  randomBytes: (byteCount) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  sha256: (data) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
};

describe("normalizeServerUrl", () => {
  it("defaults a bare hostname to https", () => {
    expect(normalizeServerUrl("box.example.com")).toBe("https://box.example.com");
  });

  it("defaults IPs and localhost to http, keeping the port", () => {
    expect(normalizeServerUrl("192.168.1.5:3773/")).toBe("http://192.168.1.5:3773");
    expect(normalizeServerUrl("localhost:3773")).toBe("http://localhost:3773");
    expect(normalizeServerUrl("[::1]:3773")).toBe("http://[::1]:3773");
  });

  it("keeps an explicit scheme and reduces everything else to the origin", () => {
    // The server rejects an `origin` with a path.
    expect(normalizeServerUrl("  http://box.example.com/base//?x=1#token=abc ")).toBe(
      "http://box.example.com",
    );
    expect(normalizeServerUrl("HTTPS://Box.Example.com")).toBe("https://box.example.com");
  });

  it("rejects empty, non-http and credentialed input", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl(undefined)).toBeNull();
    expect(normalizeServerUrl("ftp://box.example.com")).toBeNull();
    expect(normalizeServerUrl("signalbox://account-return")).toBeNull();
    expect(normalizeServerUrl("https://user:pw@box.example.com")).toBeNull();
    expect(normalizeServerUrl("not a host")).toBeNull();
  });

  it("produces an origin the authorize URL can be built from", () => {
    const origin = normalizeServerUrl("box.example.com")!;
    const url = new URL(
      buildAccountAuthorizeUrl({
        provider: "github",
        mode: "native",
        origin,
        returnUrl: "signalbox://account-return",
        challenge: "abc",
      }),
    );
    expect(url.origin).toBe("https://box.example.com");
    expect(url.pathname).toBe("/api/account/authorize");
    expect(url.searchParams.get("origin")).toBe(origin);
  });
});

describe("serverDisplayHost", () => {
  it("shows host and port", () => {
    expect(serverDisplayHost("https://box.example.com")).toBe("box.example.com");
    expect(serverDisplayHost("http://192.168.1.5:3773")).toBe("192.168.1.5:3773");
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

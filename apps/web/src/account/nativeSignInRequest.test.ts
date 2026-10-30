import { describe, expect, it } from "vite-plus/test";

import { nativeSignInRequest } from "./nativeSignInRequest";

describe("nativeSignInRequest", () => {
  it("keeps the native handoff while binding navigation to the current server", () => {
    const query = new URLSearchParams({
      provider: "email",
      mode: "native",
      origin: "https://other.example.com",
      returnUrl: "signalbox://account-return",
      challenge: "app-challenge",
      via: "web",
    });
    expect(nativeSignInRequest(query.toString(), "https://cloud.example.com")).toEqual({
      provider: "email",
      mode: "native",
      origin: "https://cloud.example.com",
      returnUrl: "signalbox://account-return",
      challenge: "app-challenge",
      via: "web",
    });
  });

  it("leaves ordinary browser sign-in and malformed requests alone", () => {
    expect(nativeSignInRequest("returnTo=/threads", "https://cloud.example.com")).toBeNull();
    expect(
      nativeSignInRequest("provider=bogus&mode=native", "https://cloud.example.com"),
    ).toBeNull();
  });
});

import { describe, expect, it } from "@effect/vitest";

import {
  AccountHandoffError,
  buildAccountAuthorizeUrl,
  parseAccountReturn,
  redeemAccountHandoff,
} from "./index.ts";

describe("redeemAccountHandoff", () => {
  const redeemWith = (status: number, body: unknown) =>
    redeemAccountHandoff(
      "http://127.0.0.1:1",
      { handoff: "h", verifier: "v" },
      { fetch: async () => new Response(JSON.stringify(body), { status }) },
    ).then(
      () => "ok",
      (error: unknown) => (error instanceof AccountHandoffError ? error.code : "other"),
    );

  it("maps refusals to sign-in error codes", async () => {
    expect(await redeemWith(404, { error: "not_found" })).toBe("expired");
    expect(await redeemWith(400, { error: "expired" })).toBe("expired");
    expect(await redeemWith(400, { error: "bogus" })).toBe("failed");
  });
});

describe("buildAccountAuthorizeUrl", () => {
  it("targets the server origin and drops empty params", () => {
    const url = new URL(
      buildAccountAuthorizeUrl({
        provider: "email",
        origin: "https://box.example.ts.net/",
        mode: "browser",
        loginHint: "a+b@example.com",
        returnTo: "",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://box.example.ts.net/api/account/authorize");
    expect(url.searchParams.get("loginHint")).toBe("a+b@example.com");
    expect(url.searchParams.has("returnTo")).toBe(false);
  });
});

describe("parseAccountReturn", () => {
  it("reads a native handoff", () => {
    expect(parseAccountReturn("signalbox://app/account-return?handoff=abc")).toEqual({
      _tag: "handoff",
      handoff: "abc",
    });
  });

  it("keeps known errors", () => {
    expect(parseAccountReturn("http://localhost:5733/sign-in?error=cancelled")).toEqual({
      _tag: "error",
      error: "cancelled",
    });
  });

  it("collapses unknown errors to failed and ignores unrelated urls", () => {
    expect(parseAccountReturn("signalbox://app/account-return?error=nope")).toEqual({
      _tag: "error",
      error: "failed",
    });
    expect(parseAccountReturn("http://localhost/sign-in")).toBeNull();
  });
});

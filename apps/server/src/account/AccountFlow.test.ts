import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import * as AccountFlow from "./AccountFlow.ts";

const CHALLENGE = AccountFlow.pkceChallenge("verifier");

const browser = (overrides: Partial<AccountAuthorizeParams> = {}): AccountAuthorizeParams => ({
  provider: "google",
  origin: "https://box.example.com",
  mode: "browser",
  ...overrides,
});

const native = (overrides: Partial<AccountAuthorizeParams> = {}): AccountAuthorizeParams => ({
  provider: "github",
  origin: "http://127.0.0.1:3773",
  mode: "native",
  returnUrl: "signalbox://auth/return",
  challenge: CHALLENGE,
  ...overrides,
});

const reason = (params: AccountAuthorizeParams) => {
  const result = AccountFlow.validateAuthorizeParams(params);
  return Result.isFailure(result) ? result.failure : null;
};

describe("validateAuthorizeParams", () => {
  it("accepts bare http(s) origins and normalizes a trailing slash", () => {
    const result = AccountFlow.validateAuthorizeParams(
      browser({ origin: "https://box.example.com/" }),
    );
    expect(Result.isSuccess(result) && result.success.origin).toBe("https://box.example.com");
    expect(reason(browser({ origin: "http://localhost:5733" }))).toBeNull();
  });

  it.each([
    "https://box.example.com/path",
    "https://box.example.com?x=1",
    "https://user:pass@box.example.com",
    "javascript:alert(1)",
    "signalbox://app",
    "box.example.com",
    "",
  ])("rejects origin %j", (origin) => {
    expect(reason(browser({ origin }))).toMatch(/origin/);
  });

  it("only accepts same-origin returnTo paths", () => {
    expect(reason(browser({ returnTo: "/threads/1?x=1" }))).toBeNull();
    for (const returnTo of ["//evil.com", "/\\evil.com", "https://evil.com", "threads", "/a\nb"]) {
      expect(reason(browser({ returnTo }))).toMatch(/returnTo/);
    }
  });

  it("defaults returnTo to the root", () => {
    const result = AccountFlow.validateAuthorizeParams(browser());
    expect(Result.isSuccess(result) && result.success.target).toEqual({
      mode: "browser",
      returnTo: "/",
    });
  });

  it("requires a Signalbox scheme returnUrl and a challenge in native mode", () => {
    expect(reason(native())).toBeNull();
    expect(reason(native({ returnUrl: "signalbox-dev://auth" }))).toBeNull();
    for (const returnUrl of ["https://evil.com/cb", "myapp://cb", "not a url"]) {
      expect(reason(native({ returnUrl }))).toMatch(/returnUrl/);
    }
    expect(reason(native({ returnUrl: undefined }))).toMatch(/returnUrl/);
    expect(reason(native({ challenge: undefined }))).toMatch(/challenge/);
    expect(reason(native({ challenge: "too-short" }))).toMatch(/challenge/);
  });

  it("accepts via=web only for native mode and lands on the origin's sign-in page", () => {
    expect(reason(browser({ via: "web" }))).toMatch(/via/);
    const web = AccountFlow.validateAuthorizeParams(native({ via: "web" }));
    if (Result.isFailure(web)) throw new Error(web.failure);
    expect(web.success.target).toMatchObject({
      mode: "native",
      returnUrl: "signalbox://auth/return",
      via: "web",
    });
    // Still a native request: the app's return URL and challenge are required.
    expect(reason(native({ via: "web", returnUrl: "https://evil.com" }))).toMatch(/returnUrl/);
    expect(reason(native({ via: "web", challenge: undefined }))).toMatch(/challenge/);
    // An expired attempt still lands on the page, still carrying the return URL.
    expect(AccountFlow.nativeReturnFromState(AccountFlow.attemptState(web.success.target))).toEqual(
      { returnUrl: "signalbox://auth/return", via: "web" },
    );
  });

  it("keeps loginHint only for the email provider", () => {
    const email = AccountFlow.validateAuthorizeParams(
      browser({ provider: "email", loginHint: "a@b.c" }),
    );
    const google = AccountFlow.validateAuthorizeParams(browser({ loginHint: "a@b.c" }));
    expect(Result.isSuccess(email) && email.success.loginHint).toBe("a@b.c");
    expect(Result.isSuccess(google) && google.success.loginHint).toBeUndefined();
  });
});

describe("buildWorkOSAuthorizeUrl", () => {
  const build = (params: AccountAuthorizeParams) => {
    const validated = AccountFlow.validateAuthorizeParams(params);
    if (Result.isFailure(validated)) throw new Error(validated.failure);
    return new URL(
      AccountFlow.buildWorkOSAuthorizeUrl({
        apiBaseUrl: "https://api.workos.com",
        clientId: "client_1",
        request: validated.success,
        state: "state_1",
        codeChallenge: "challenge_1",
      }),
    );
  };

  it("sends a PKCE authorization request to the same-origin callback", () => {
    const url = build(browser());
    expect(url.origin + url.pathname).toBe("https://api.workos.com/user_management/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client_1",
      redirect_uri: "https://box.example.com/api/account/callback",
      provider: "GoogleOAuth",
      state: "state_1",
      code_challenge: "challenge_1",
      code_challenge_method: "S256",
    });
  });

  it("maps providers and account selection", () => {
    expect(build(browser({ provider: "github" })).searchParams.get("provider")).toBe("GitHubOAuth");
    expect(build(browser({ provider: "apple" })).searchParams.get("provider")).toBe("AppleOAuth");

    const google = build(browser({ selectAccount: "1" }));
    expect(google.searchParams.get("provider_query_params[prompt]")).toBe("select_account");
    expect(google.searchParams.has("max_age")).toBe(false);

    const email = build(
      browser({ provider: "email", loginHint: "a@b.c", selectAccount: "1", screenHint: "sign-up" }),
    );
    expect(email.searchParams.get("screen_hint")).toBe("sign-up");
    expect(build(browser({ screenHint: "sign-up" })).searchParams.has("screen_hint")).toBe(false);
    expect(email.searchParams.get("provider")).toBe("authkit");
    expect(email.searchParams.get("login_hint")).toBe("a@b.c");
    expect(email.searchParams.get("max_age")).toBe("0");
  });
});

describe("attempt state", () => {
  it("carries a native return URL so expired attempts can still return to the app", () => {
    const target = {
      mode: "native",
      returnUrl: "signalbox-dev://auth/return?x=1",
      challenge: CHALLENGE,
    } as const;
    const state = AccountFlow.attemptState(target);
    expect(AccountFlow.nativeReturnFromState(state)).toEqual({ returnUrl: target.returnUrl });
    expect(AccountFlow.attemptState(target)).not.toBe(state);
  });

  it("never yields a return URL for browser, missing, or forged states", () => {
    const browserState = AccountFlow.attemptState({ mode: "browser", returnTo: "/" });
    expect(browserState).not.toContain(".");
    expect(AccountFlow.nativeReturnFromState(browserState)).toBeUndefined();
    expect(AccountFlow.nativeReturnFromState(undefined)).toBeUndefined();
    for (const returnUrl of ["https://evil.com/", "javascript:alert(1)", "myapp://cb"]) {
      const forged = `nonce.${Buffer.from(returnUrl).toString("base64url")}`;
      expect(AccountFlow.nativeReturnFromState(forged)).toBeUndefined();
    }
    expect(AccountFlow.nativeReturnFromState("nonce.!!!")).toBeUndefined();
    const valid = Buffer.from("signalbox://auth").toString("base64url");
    expect(AccountFlow.nativeReturnFromState(`nonce.${valid}.other`)).toBeUndefined();
    expect(AccountFlow.nativeReturnFromState(`nonce.${valid}.web.extra`)).toBeUndefined();
  });
});

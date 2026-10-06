import * as AccountFlow from "@signalbox/account/AccountFlow";
import type { WorkOSCodes } from "@signalbox/account/WorkOSTesting";
import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { CLOUD_TEST_ENV, layerAccounts } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudAccounts from "./CloudAccounts.ts";

const VERIFIER = "native-client-verifier-0123456789abcdefghijklmnop";
const CODES: WorkOSCodes = {
  "code-ada": { id: "user_ada", email: "ada@example.com", first_name: "Ada" },
  "code-github": {
    verify: { code: "123456", user: { id: "user_gh", email: "gh@example.com" } },
  },
  "code-mfa": { fail: "mfa_enrollment" },
};
const ORIGIN = "https://cloud.example.com";

const browserParams: AccountAuthorizeParams = {
  provider: "google",
  origin: ORIGIN,
  mode: "browser",
  returnTo: "/threads",
};
const nativeParams: AccountAuthorizeParams = {
  provider: "email",
  origin: ORIGIN,
  mode: "native",
  returnUrl: "signalbox://account-return",
  challenge: AccountFlow.pkceChallenge(VERIFIER),
};

const stateOf = (authorized: { readonly location: string }) =>
  new URL(authorized.location).searchParams.get("state") ?? "";

/**
 * authorize, WorkOS (skipped), then the callback, as a browser would drive it:
 * the binding cookie `authorize` set comes back with the callback.
 */
const signIn = (params: AccountAuthorizeParams, input: { code?: string; error?: string }) =>
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const authorized = yield* accounts.authorize(params);
    return yield* accounts.callback({
      state: stateOf(authorized),
      ...input,
      ...(authorized.binding ? { binding: authorized.binding } : {}),
    });
  });

const locationOf = (result: CloudAccounts.SignInResult) => new URL(result.location, ORIGIN);

const withKey = { ...CLOUD_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" };

describe("CloudAccounts", () => {
  it.effect("browser sign-in sets a session the account routes recognize, until sign-out", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const result = yield* signIn(browserParams, { code: "code-ada" });
      if (result._tag !== "BrowserSession") throw new Error("expected a browser session");
      expect(result.location).toBe("/threads");

      const signedIn = yield* accounts.sessionState({ cookie: result.token });
      expect(signedIn.account).toEqual({
        id: "user_ada",
        email: "ada@example.com",
        firstName: "Ada",
      });

      yield* accounts.signOut({ cookie: result.token });
      expect((yield* accounts.sessionState({ cookie: result.token })).account).toBeNull();
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("native sign-in hands the app a handoff only its verifier redeems, once", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const sessions = yield* CloudSessions.CloudSessions;
      const result = yield* signIn(nativeParams, { code: "code-ada" });
      const returned = new URL(result.location);
      expect(`${returned.protocol}//${returned.host}${returned.pathname}`).toBe(
        "signalbox://account-return",
      );
      const handoff = returned.searchParams.get("handoff") ?? "";

      const wrong = yield* accounts.redeemHandoff({ handoff, verifier: "wrong" }).pipe(Effect.flip);
      expect(wrong.error).toBe("failed");
      const redeemed = yield* accounts.redeemHandoff({ handoff, verifier: VERIFIER });
      expect(redeemed.account.id).toBe("user_ada");
      const again = yield* accounts
        .redeemHandoff({ handoff, verifier: VERIFIER })
        .pipe(Effect.flip);
      expect(again.error).toBe("expired");

      const exchange = () =>
        sessions.exchangeCredential(redeemed.credential, {
          method: "bearer-access-token",
          scopes: CloudSessions.CLOUD_SESSION_SCOPES,
        });
      const { session, token } = yield* exchange();
      expect(session.userId).toBe("user_ada");
      expect((yield* sessions.authenticate({ bearer: token })).sessionId).toBe(session.sessionId);
      expect((yield* exchange().pipe(Effect.flip))._tag).toBe("CloudCredentialError");
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("each WorkOS user gets their own object", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const ada = yield* signIn(browserParams, { code: "code-ada" });
      if (ada._tag !== "BrowserSession") throw new Error("expected a browser session");
      const sessions = yield* CloudSessions.CloudSessions;
      const users = yield* UserDirectory.UserDirectory;
      const session = yield* sessions.authenticate({ cookie: ada.token });
      // Another user's object has never heard of Ada's session.
      expect(yield* users.forUser("user_gh").findSession(session.sessionId)).toBeNull();
      expect((yield* accounts.sessionState({ cookie: ada.token })).account?.id).toBe("user_ada");
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("pauses for an emailed code and finishes the original attempt", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const paused = locationOf(yield* signIn(nativeParams, { code: "code-github" }));
      expect(paused.pathname).toBe("/sign-in");
      expect(paused.searchParams.get("email")).toBe("gh@example.com");
      const verify = paused.searchParams.get("verify") ?? "";

      const wrong = yield* accounts
        .verifyEmail({ verify, code: "000000" }, undefined)
        .pipe(Effect.flip);
      expect(wrong.error).toBe("invalid-code");
      const done = yield* accounts.verifyEmail({ verify, code: "123456" }, undefined);
      expect(new URL(done.location).searchParams.get("handoff")).toBeTruthy();
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );

  it.effect("finishes a browser sign-in only in the browser that started it", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      // An attacker's own attempt, finished at WorkOS, then handed to a victim.
      const authorized = yield* accounts.authorize(browserParams);
      expect(authorized.binding).toBeTruthy();
      const state = stateOf(authorized);
      const victim = yield* accounts.callback({ state, code: "code-ada" });
      expect(victim).toEqual({ _tag: "Redirect", location: "/sign-in?error=failed" });
      const other = yield* accounts.callback({ state, code: "code-ada", binding: "someone-else" });
      expect(other).toEqual({ _tag: "Redirect", location: "/sign-in?error=failed" });
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("binds a paused browser sign-in to its browser too", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const authorized = yield* accounts.authorize(browserParams);
      const paused = locationOf(
        yield* accounts.callback({
          state: stateOf(authorized),
          code: "code-github",
          binding: authorized.binding ?? "",
        }),
      );
      const verify = paused.searchParams.get("verify") ?? "";
      const stolen = yield* accounts
        .verifyEmail({ verify, code: "123456" }, undefined)
        .pipe(Effect.flip);
      expect(stolen.error).toBe("failed");
      const done = yield* accounts.verifyEmail({ verify, code: "123456" }, authorized.binding);
      expect(done._tag).toBe("BrowserSession");
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );

  it.effect("cannot finish email verification without the API key", () =>
    Effect.gen(function* () {
      const result = yield* signIn(browserParams, { code: "code-github" });
      expect(result.location).toBe("/sign-in?error=failed");
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("reports cancellations, failures and expiry where the attempt started", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      expect((yield* signIn(browserParams, { error: "access_denied" })).location).toBe(
        "/sign-in?error=cancelled",
      );
      expect((yield* signIn(browserParams, { code: "code-mfa" })).location).toBe(
        "/sign-in?error=failed",
      );

      const state = stateOf(yield* accounts.authorize(nativeParams));
      yield* TestClock.adjust("11 minutes");
      const expired = new URL((yield* accounts.callback({ state, code: "code-ada" })).location);
      expect(expired.protocol).toBe("signalbox:");
      expect(expired.searchParams.get("error")).toBe("expired");

      const forged = yield* accounts.callback({ state: `${state}x`, code: "code-ada" });
      expect(forged.location).toBe("/sign-in?error=expired");
    }).pipe(Effect.provide(layerAccounts(CODES))),
  );

  it.effect("refuses providers the deployment does not offer", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const refused = yield* accounts.authorize(browserParams).pipe(Effect.flip);
      expect(refused._tag).toBe("CloudSignInRequestError");
    }).pipe(
      Effect.provide(
        layerAccounts(CODES, { ...CLOUD_TEST_ENV, T3CODE_WORKOS_PROVIDERS: "github" }),
      ),
    ),
  );
});

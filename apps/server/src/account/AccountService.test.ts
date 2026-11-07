import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import { describe, expect, it } from "@effect/vitest";
import {
  ORGANIZATION_SELECTION_GRANT,
  WORKOS_TEST_ENV,
  type WorkOSCodes,
} from "@signalbox/account/WorkOSTesting";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AccountFlow from "@signalbox/account/AccountFlow";
import * as AccountService from "./AccountService.ts";
import type * as AccountSessions from "./AccountSessions.ts";
import {
  CODES,
  VERIFIER,
  anonymousRequest,
  bearerRequest,
  browserParams,
  cookieRequest,
  nativeParams,
  runAccountTest as run,
  signIn,
} from "./testing.ts";

const handoffOf = (result: AccountSessions.AccountCallbackResult) => {
  const url = new URL(result.location);
  expect(url.protocol).toBe("signalbox:");
  return url.searchParams.get("handoff") ?? "";
};

const WITH_WORKOS_KEY = { ...WORKOS_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" };

describe("AccountService native handoff", () => {
  it.effect("redeems once with the PKCE verifier, yielding an account session", () => {
    const exchanges: Array<Record<string, unknown>> = [];
    return run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const authorizeUrl = new URL(yield* accounts.authorize(nativeParams));
        const result = yield* accounts.callback(
          { state: authorizeUrl.searchParams.get("state") ?? "", code: "code-owner" },
          anonymousRequest,
        );
        const handoff = handoffOf(result);
        const accountLinks = auth
          .listPairingLinks()
          .pipe(
            Effect.map((links) => links.filter((link) => link.subject === "account:user_owner")),
          );
        // Nothing to see in Connections until the app redeems.
        expect(yield* accountLinks).toHaveLength(0);

        // The server's own WorkOS PKCE pair is consistent and stays server-side.
        expect(exchanges).toHaveLength(1);
        expect(AccountFlow.pkceChallenge(String(exchanges[0]?.code_verifier))).toBe(
          authorizeUrl.searchParams.get("code_challenge"),
        );
        expect(exchanges[0]).not.toHaveProperty("client_secret");

        const wrong = yield* Effect.flip(
          accounts.redeemHandoff({ handoff, verifier: "someone-elses-verifier" }),
        );
        expect(wrong._tag).toBe("AccountHandoffRejectedError");

        const redeemed = yield* accounts.redeemHandoff({ handoff, verifier: VERIFIER });
        expect(redeemed.account).toEqual({
          id: "user_owner",
          email: "owner@example.com",
          firstName: "Ada",
        });
        expect(yield* accountLinks).toHaveLength(1);

        const replay = yield* Effect.flip(accounts.redeemHandoff({ handoff, verifier: VERIFIER }));
        expect(replay._tag).toBe("AccountHandoffNotFoundError");

        const session = yield* auth.createBrowserSession(redeemed.credential, {
          deviceType: "desktop",
        });
        const sessions = yield* SessionStore.SessionStore;
        const authenticated = yield* auth.authenticateHttpRequest(
          cookieRequest(session.cookieName ?? sessions.cookieName, session.sessionToken),
        );
        expect(authenticated.subject).toBe("account:user_owner");
      }),
      { codes: CODES, exchanges },
    );
  });

  it.effect("expires after five minutes", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const handoff = handoffOf(yield* signIn(nativeParams, "code-owner"));
        yield* TestClock.adjust("5 minutes");
        const error = yield* Effect.flip(accounts.redeemHandoff({ handoff, verifier: VERIFIER }));
        expect(error._tag).toBe("AccountHandoffNotFoundError");
      }),
    ),
  );

  it.effect("is destroyed after five wrong verifiers", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const handoff = handoffOf(yield* signIn(nativeParams, "code-owner"));
        for (let attempt = 0; attempt < 5; attempt++) {
          const error = yield* Effect.flip(accounts.redeemHandoff({ handoff, verifier: "guess" }));
          expect(error._tag).toBe("AccountHandoffRejectedError");
        }
        const error = yield* Effect.flip(accounts.redeemHandoff({ handoff, verifier: VERIFIER }));
        expect(error._tag).toBe("AccountHandoffNotFoundError");
      }),
    ),
  );
});

describe("AccountService accounts", () => {
  it.effect("signs in any WorkOS account and shows its latest profile", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const sessions = yield* SessionStore.SessionStore;
        const stateOf = (result: AccountSessions.AccountCallbackResult) => {
          if (result._tag !== "BrowserSession") throw new Error(result.location);
          return accounts.sessionState(
            cookieRequest(
              result.session.cookieName ?? sessions.cookieName,
              result.session.sessionToken,
            ),
          );
        };
        expect(yield* accounts.sessionState(anonymousRequest)).toEqual({
          enabled: true,
          providers: ["google", "github", "apple", "email"],
          account: null,
        });

        const first = yield* signIn(browserParams, "code-owner");
        expect(first.location).toBe("/threads");
        expect((yield* stateOf(first)).account).toEqual({
          id: "user_owner",
          email: "owner@example.com",
          firstName: "Ada",
        });
        const second = yield* signIn(browserParams, "code-other");
        expect((yield* stateOf(second)).account).toEqual({
          id: "user_other",
          email: "other@example.com",
        });
        // Signing in again refreshes the stored profile.
        const renamed = yield* signIn(browserParams, "code-owner-renamed");
        expect((yield* stateOf(renamed)).account?.firstName).toBe("Ada L.");

        // Any non-account session is not an account.
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const bootstrap = yield* auth.issueSession({ subject: "desktop-bootstrap" });
        expect((yield* accounts.sessionState(bearerRequest(bootstrap.token))).account).toBeNull();
      }),
    ),
  );
});

describe("AccountService email sign-in", () => {
  it.effect(
    "returns native email requests to the relative sign-in page with their PKCE target",
    () => {
      const exchanges: Array<Record<string, unknown>> = [];
      return run(
        Effect.gen(function* () {
          const accounts = yield* AccountService.AccountService;
          const params: AccountAuthorizeParams = {
            provider: "email",
            origin: "https://attacker.example",
            mode: "native",
            returnUrl: "signalbox://auth/return",
            challenge: nativeParams.challenge,
            via: "web",
            screenHint: "sign-up",
            selectAccount: "1",
          };
          const location = yield* accounts.authorize(params);
          const url = new URL(location, "https://box.example.com");
          expect(location.startsWith("/sign-in?")).toBe(true);
          expect(url.origin).toBe("https://box.example.com");
          expect(url.searchParams.get("provider")).toBe("email");
          expect(url.searchParams.get("origin")).toBe("https://attacker.example");
          expect(url.searchParams.get("mode")).toBe("native");
          expect(url.searchParams.get("returnUrl")).toBe("signalbox://auth/return");
          expect(url.searchParams.get("challenge")).toBe(nativeParams.challenge);
          expect(url.searchParams.get("via")).toBe("web");
          expect(url.searchParams.get("screenHint")).toBe("sign-up");
          expect(url.searchParams.get("selectAccount")).toBe("1");
          expect(exchanges).toHaveLength(0);
        }),
        { exchanges },
      );
    },
  );

  it.effect(
    "pins a known email to its personal organization and rejects a changed identity",
    () => {
      const exchanges: Array<Record<string, unknown>> = [];
      const knownUser = { id: "user_known", email: "known@example.com" };
      const codes: WorkOSCodes = {
        "code-known": { select: { user: knownUser, organizationId: "org-personal" } },
        "code-other": { id: "user_other", email: "other@example.com" },
      };
      const params: AccountAuthorizeParams = {
        ...browserParams,
        provider: "email",
        loginHint: "known@example.com",
      };
      return run(
        Effect.gen(function* () {
          const accounts = yield* AccountService.AccountService;
          const authorizeUrl = new URL(yield* accounts.authorize(params));
          expect(authorizeUrl.searchParams.get("organization_id")).toBe("org-personal");

          const signedIn = yield* accounts.callback(
            { state: authorizeUrl.searchParams.get("state") ?? "", code: "code-known" },
            anonymousRequest,
          );
          expect(signedIn).toMatchObject({ _tag: "BrowserSession", location: "/threads" });
          expect(
            exchanges.find((body) => body.grant_type === ORGANIZATION_SELECTION_GRANT),
          ).toMatchObject({
            organization_id: "org-personal",
            pending_authentication_token: "selection-code-known",
          });

          const secondAuthorizeUrl = new URL(yield* accounts.authorize(params));
          const changedIdentity = yield* accounts.callback(
            {
              state: secondAuthorizeUrl.searchParams.get("state") ?? "",
              code: "code-other",
            },
            anonymousRequest,
          );
          expect(changedIdentity).toEqual({ _tag: "Redirect", location: "/sign-in?error=failed" });
        }),
        {
          codes,
          exchanges,
          memberships: { user_known: [{ id: "org-personal", name: "Personal" }] },
          env: WITH_WORKOS_KEY,
        },
      );
    },
  );
});

describe("AccountService native sign-in via the web page", () => {
  const webParams: AccountAuthorizeParams = { ...nativeParams, via: "web" };

  it.effect("returns handoffs and errors to /sign-in on the origin", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const success = new URL((yield* signIn(webParams, "code-owner")).location);
        expect(success.origin + success.pathname).toBe("https://box.example.com/sign-in");
        expect(success.searchParams.get("returnUrl")).toBe("signalbox://auth/return");
        const handoff = success.searchParams.get("handoff") ?? "";
        const redeemed = yield* accounts.redeemHandoff({ handoff, verifier: VERIFIER });
        expect(redeemed.account.id).toBe("user_owner");

        const cancelledState = new URL(yield* accounts.authorize(webParams)).searchParams.get(
          "state",
        );
        const cancelled = yield* accounts.callback(
          { state: cancelledState ?? "", error: "access_denied" },
          anonymousRequest,
        );
        expect(cancelled.location).toBe(
          "https://box.example.com/sign-in?error=cancelled&returnUrl=signalbox%3A%2F%2Fauth%2Freturn",
        );

        const state = new URL(yield* accounts.authorize(webParams)).searchParams.get("state");
        yield* TestClock.adjust("10 minutes");
        const expired = yield* accounts.callback(
          { state: state ?? "", code: "code-owner" },
          anonymousRequest,
        );
        expect(expired.location).toBe(
          "/sign-in?error=expired&returnUrl=signalbox%3A%2F%2Fauth%2Freturn",
        );
      }),
    ),
  );

  it.effect("rejects via=web outside native mode", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const error = yield* Effect.flip(accounts.authorize({ ...browserParams, via: "web" }));
        expect(error._tag).toBe("AccountInvalidRequestError");
      }),
    ),
  );
});

describe("AccountService callback errors", () => {
  it.effect("maps unknown state, provider errors and failed exchanges", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const startState = Effect.map(
          accounts.authorize(browserParams),
          (url) => new URL(url).searchParams.get("state") ?? "",
        );

        const expired = yield* accounts.callback(
          { state: "unknown", code: "code-owner" },
          anonymousRequest,
        );
        expect(expired.location).toBe("/sign-in?error=expired");

        const cancelledState = yield* startState;
        const cancelled = yield* accounts.callback(
          { state: cancelledState, error: "access_denied" },
          anonymousRequest,
        );
        expect(cancelled.location).toBe("/sign-in?error=cancelled");
        // The attempt is single use.
        const replay = yield* accounts.callback(
          { state: cancelledState, code: "code-owner" },
          anonymousRequest,
        );
        expect(replay.location).toBe("/sign-in?error=expired");

        const otherError = yield* accounts.callback(
          { state: yield* startState, error: "organization_invalid" },
          anonymousRequest,
        );
        expect(otherError.location).toBe("/sign-in?error=failed");

        const badCode = yield* accounts.callback(
          { state: yield* startState, code: "nope" },
          anonymousRequest,
        );
        expect(badCode.location).toBe("/sign-in?error=failed");

        const nativeCancel = new URL(
          (yield* accounts.callback(
            {
              state:
                new URL(yield* accounts.authorize(nativeParams)).searchParams.get("state") ?? "",
              error: "access_denied",
            },
            anonymousRequest,
          )).location,
        );
        expect(nativeCancel.href).toBe("signalbox://auth/return?error=cancelled");
      }),
    ),
  );

  it.effect("sends an expired native attempt back to the app it came from", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const state =
          new URL(yield* accounts.authorize(nativeParams)).searchParams.get("state") ?? "";
        yield* TestClock.adjust("10 minutes");
        const expired = yield* accounts.callback({ state, code: "code-owner" }, anonymousRequest);
        expect(expired.location).toBe("signalbox://auth/return?error=expired");

        // A forged suffix never becomes a redirect target.
        const forged = `nonce.${Buffer.from("https://evil.com/").toString("base64url")}`;
        const rejected = yield* accounts.callback(
          { state: forged, code: "code-owner" },
          anonymousRequest,
        );
        expect(rejected.location).toBe("/sign-in?error=expired");
      }),
    ),
  );

  it.effect("sends the API key as client_secret when configured", () => {
    const exchanges: Array<Record<string, unknown>> = [];
    return run(signIn(browserParams, "code-owner"), {
      codes: CODES,
      exchanges,
      env: { ...WORKOS_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" },
    }).pipe(
      Effect.tap(() => Effect.sync(() => expect(exchanges[0]?.client_secret).toBe("sk_test"))),
    );
  });
});

describe("AccountService without WorkOS", () => {
  it.effect("reports accounts disabled and refuses to start sign-in", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        expect(yield* accounts.sessionState(anonymousRequest)).toEqual({
          enabled: false,
          providers: [],
          account: null,
        });
        const error = yield* Effect.flip(accounts.authorize(browserParams));
        expect(error._tag).toBe("AccountDisabledError");
      }),
      { env: {} },
    ),
  );
});

describe("AccountService providers", () => {
  it.effect("offers only configured providers, in order, and refuses the rest", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const state = yield* accounts.sessionState(anonymousRequest);
        expect(state.providers).toEqual(["github", "email"]);
        const refused = yield* Effect.flip(accounts.authorize(browserParams));
        expect(refused._tag).toBe("AccountInvalidRequestError");
        yield* accounts.authorize({ ...browserParams, provider: "github" });
      }),
      {
        codes: CODES,
        env: { ...WORKOS_TEST_ENV, T3CODE_WORKOS_PROVIDERS: " GitHub, bogus,email,github " },
      },
    ),
  );
});

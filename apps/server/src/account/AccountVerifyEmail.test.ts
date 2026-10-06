import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import { describe, expect, it } from "@effect/vitest";
import { EMAIL_VERIFICATION_GRANT, WORKOS_TEST_ENV } from "@signalbox/account/WorkOSTesting";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as AccountService from "./AccountService.ts";
import {
  CODES,
  VERIFIER,
  anonymousRequest,
  browserParams,
  cookieRequest,
  nativeParams,
  runAccountTest,
  signIn,
} from "./testing.ts";

/** Signs in with the GitHub-style code and returns the paused verification id. */
const pausedSignIn = (params: AccountAuthorizeParams) =>
  Effect.gen(function* () {
    const result = yield* signIn(params, "code-github");
    const url = new URL(result.location);
    expect(url.origin + url.pathname).toBe("https://box.example.com/sign-in");
    expect(url.searchParams.get("email")).toBe("gh@example.com");
    return url.searchParams.get("verify") ?? "";
  });

/** Email verification needs the client secret, so these servers have an API key. */
const WITH_KEY = { ...WORKOS_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" };
const run = <A, E>(
  effect: Parameters<typeof runAccountTest<A, E>>[0],
  options: { readonly exchanges?: Array<Record<string, unknown>> } = {},
) => runAccountTest(effect, { codes: CODES, env: WITH_KEY, ...options });

const verify = (id: string, code: string) =>
  Effect.flatMap(AccountService.AccountService, (accounts) =>
    accounts.verifyEmail({ verify: id, code }, anonymousRequest),
  );

describe("email verification", () => {
  it.effect("finishes a browser sign-in after a wrong code, exactly as the callback would", () => {
    const exchanges: Array<Record<string, unknown>> = [];
    return run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const sessions = yield* SessionStore.SessionStore;
        const id = yield* pausedSignIn(browserParams);

        const wrong = yield* Effect.flip(verify(id, "000000"));
        expect(wrong._tag).toBe("AccountVerificationCodeRejectedError");

        const result = yield* verify(id, "123456");
        if (result._tag !== "BrowserSession") throw new Error(result.location);
        expect(result.location).toBe("/threads");
        const state = yield* accounts.sessionState(
          cookieRequest(
            result.session.cookieName ?? sessions.cookieName,
            result.session.sessionToken,
          ),
        );
        expect(state.account).toEqual({ id: "user_github", email: "gh@example.com" });

        const reused = yield* Effect.flip(verify(id, "123456"));
        expect(reused._tag).toBe("AccountVerificationExpiredError");

        const grants = exchanges.filter((body) => body.grant_type === EMAIL_VERIFICATION_GRANT);
        expect(grants[1]).toMatchObject({
          client_id: "client_test",
          code: "123456",
          pending_authentication_token: "pending-code-github",
        });
        expect(grants[1]).not.toHaveProperty("code_verifier");
      }),
      { exchanges },
    );
  });

  it.effect("parks a native handoff, direct or via the web page", () =>
    run(
      Effect.gen(function* () {
        const accounts = yield* AccountService.AccountService;
        const direct = new URL(
          (yield* verify(yield* pausedSignIn(nativeParams), "123456")).location,
        );
        expect(direct.protocol).toBe("signalbox:");
        const handoff = direct.searchParams.get("handoff") ?? "";
        const redeemed = yield* accounts.redeemHandoff({ handoff, verifier: VERIFIER });
        expect(redeemed.account.id).toBe("user_github");

        const viaWeb = new URL(
          (yield* verify(yield* pausedSignIn({ ...nativeParams, via: "web" }), "123456")).location,
        );
        expect(viaWeb.origin + viaWeb.pathname).toBe("https://box.example.com/sign-in");
        expect(viaWeb.searchParams.get("returnUrl")).toBe("signalbox://auth/return");
        expect(viaWeb.searchParams.has("handoff")).toBe(true);
      }),
    ),
  );

  it.effect("expires after five wrong codes or ten minutes", () =>
    run(
      Effect.gen(function* () {
        const burned = yield* pausedSignIn(browserParams);
        for (let attempt = 0; attempt < 5; attempt++) {
          const error = yield* Effect.flip(verify(burned, "000000"));
          expect(error._tag).toBe("AccountVerificationCodeRejectedError");
        }
        expect((yield* Effect.flip(verify(burned, "123456")))._tag).toBe(
          "AccountVerificationExpiredError",
        );

        const stale = yield* pausedSignIn(browserParams);
        yield* TestClock.adjust("10 minutes");
        expect((yield* Effect.flip(verify(stale, "123456")))._tag).toBe(
          "AccountVerificationExpiredError",
        );
        expect((yield* Effect.flip(verify("unknown", "123456")))._tag).toBe(
          "AccountVerificationExpiredError",
        );
      }),
    ),
  );

  it.effect("fails instead of pausing when there is no API key to finish with", () => {
    const exchanges: Array<Record<string, unknown>> = [];
    return runAccountTest(
      Effect.gen(function* () {
        const result = yield* signIn(browserParams, "code-github");
        expect(result.location).toBe("/sign-in?error=failed");
        const native = new URL((yield* signIn(nativeParams, "code-github")).location);
        expect(native.href).toBe("signalbox://auth/return?error=failed");
        expect(exchanges.some((body) => body.grant_type === EMAIL_VERIFICATION_GRANT)).toBe(false);
      }),
      { codes: CODES, exchanges },
    );
  });

  it.effect("treats other WorkOS challenges as a failed sign-in", () =>
    run(
      Effect.gen(function* () {
        const result = yield* signIn(browserParams, "code-mfa");
        expect(result.location).toBe("/sign-in?error=failed");
      }),
    ),
  );
});

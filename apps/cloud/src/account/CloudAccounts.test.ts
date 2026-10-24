import * as AccountFlow from "@signalbox/account/AccountFlow";
import type { WorkOSCodes } from "@signalbox/account/WorkOSTesting";
import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
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
  "code-multi": {
    select: {
      user: { id: "user_multi", email: "multi@example.com" },
      organizationId: "org_personal",
    },
  },
  "code-multi-verify": {
    select: {
      user: { id: "user_multi", email: "multi@example.com" },
      organizationId: "org_personal",
      verifyCode: "123456",
    },
  },
  "654321": { id: "user_magic", email: "magic@example.com" },
};
const ORIGIN = "https://cloud.example.com";

const browserParams: AccountAuthorizeParams = {
  provider: "google",
  origin: ORIGIN,
  mode: "browser",
  returnTo: "/threads",
};
const nativeParams: AccountAuthorizeParams = {
  provider: "github",
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
  it.effect("uses a trusted caller's WorkOS realm for the sign-in membership sync", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; authorization: string | undefined }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          const { pathname } = new URL(request.url);
          return HttpClientResponse.fromWeb(
            request,
            pathname === "/user_management/organization_memberships"
              ? Response.json({
                  data: [{ organization_id: "org_sandbox", organization_name: "Test company" }],
                  list_metadata: { after: null },
                })
              : pathname === "/organizations/external_id/personal%3Auser_sandbox"
                ? Response.json({ code: "entity_not_found" }, { status: 404 })
                : Response.json({ error: "unexpected request" }, { status: 500 }),
          );
        }),
      );
      yield* CloudAccounts.CloudAccounts.use((service) =>
        service.finishSignIn(
          { origin: ORIGIN, codeVerifier: "", target: { mode: "browser", returnTo: "/" } },
          { id: "user_sandbox", email: "richard@piedpiper.example" },
          {
            clientId: "client_sandbox",
            apiKey: Redacted.make("sk_test_sandbox"),
            apiBaseUrl: "https://sandbox.workos.test",
          },
        ),
      ).pipe(
        Effect.provide(
          Layer.fresh(CloudAccounts.layer).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
      // The listing and the personal organization come from the same realm and key.
      expect(requests.toSorted((a, b) => a.url.localeCompare(b.url))).toEqual([
        {
          url: "https://sandbox.workos.test/organizations/external_id/personal%3Auser_sandbox",
          authorization: "Bearer sk_test_sandbox",
        },
        {
          url: "https://sandbox.workos.test/user_management/organization_memberships",
          authorization: "Bearer sk_test_sandbox",
        },
      ]);
      const users = yield* UserDirectory.UserDirectory;
      const shell = yield* users.forUser("user_sandbox").shellSnapshot();
      expect(JSON.stringify(shell)).toContain("org_sandbox");
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );
  const multiMemberships = {
    user_multi: [
      { id: "org_work", name: "Work" },
      { id: "org_personal", name: "Personal" },
    ],
  };

  it.effect(
    "finishes social selection into the personal org without adding it to the sidebar",
    () =>
      Effect.gen(function* () {
        const result = yield* signIn(browserParams, { code: "code-multi" });
        expect(result._tag).toBe("BrowserSession");
        const users = yield* UserDirectory.UserDirectory;
        const shell = yield* users.forUser("user_multi").shellSnapshot();
        expect(shell.projects.map((project) => `${project.id} ${project.title}`)).toEqual([
          "scratch Scratch",
          "context:org_work Work",
        ]);
        const accounts = yield* CloudAccounts.CloudAccounts;
        yield* accounts.refreshContexts("user_multi");
        expect((yield* users.forUser("user_multi").shellSnapshot()).projects).toEqual(
          shell.projects,
        );
      }).pipe(Effect.provide(layerAccounts(CODES, withKey, multiMemberships))),
  );

  it.effect(
    "finishes organization selection after GitHub email verification in the bound browser",
    () =>
      Effect.gen(function* () {
        const accounts = yield* CloudAccounts.CloudAccounts;
        const authorized = yield* accounts.authorize({ ...browserParams, provider: "github" });
        const paused = locationOf(
          yield* accounts.callback({
            state: stateOf(authorized),
            code: "code-multi-verify",
            binding: authorized.binding ?? "",
          }),
        );
        const verify = paused.searchParams.get("verify") ?? "";
        expect(
          (yield* accounts.verifyEmail({ verify, code: "123456" }, "wrong").pipe(Effect.flip))
            .error,
        ).toBe("failed");
        expect(
          (yield* accounts.verifyEmail({ verify, code: "123456" }, authorized.binding))._tag,
        ).toBe("BrowserSession");
      }).pipe(Effect.provide(layerAccounts(CODES, withKey, multiMemberships))),
  );

  it.effect("pins hosted email sign-in to the known personal organization", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const authorized = yield* accounts.authorize({
        ...browserParams,
        provider: "email",
        loginHint: "multi@example.com",
      });
      expect(new URL(authorized.location).searchParams.get("organization_id")).toBe("org_personal");
      const changedIdentity = yield* accounts.callback({
        state: stateOf(authorized),
        code: "code-ada",
        binding: authorized.binding ?? "",
      });
      expect(changedIdentity.location).toBe("/sign-in?error=failed");
    }).pipe(Effect.provide(layerAccounts(CODES, withKey, multiMemberships))),
  );

  it.effect("a returning browser pins native sign-in and can still choose another account", () =>
    Effect.gen(function* () {
      const result = yield* signIn(browserParams, { code: "code-multi" });
      if (result._tag !== "BrowserSession") throw new Error("expected session");
      const accounts = yield* CloudAccounts.CloudAccounts;
      const params = { ...nativeParams, provider: "email" as const };
      const returning = yield* accounts.authorize(params, { cookie: result.token });
      expect(new URL(returning.location).searchParams.get("organization_id")).toBe("org_personal");
      const another = yield* accounts.authorize(
        { ...params, selectAccount: "1" },
        { cookie: result.token },
      );
      expect(new URL(another.location, ORIGIN).origin).toBe(ORIGIN);
    }).pipe(Effect.provide(layerAccounts(CODES, withKey, multiMemberships))),
  );

  it.effect("cold email sign-in stays in Signalbox and finishes with an emailed code", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const authorized = yield* accounts.authorize({
        ...browserParams,
        provider: "email",
        loginHint: "magic@example.com",
      });
      const paused = new URL(authorized.location, ORIGIN);
      expect(paused.origin).toBe(ORIGIN);
      expect(paused.pathname).toBe("/sign-in");
      const verify = paused.searchParams.get("verify") ?? "";
      expect(
        (yield* accounts
          .verifyEmail({ verify, code: "000000" }, authorized.binding)
          .pipe(Effect.flip)).error,
      ).toBe("invalid-code");
      expect(
        (yield* accounts.verifyEmail({ verify, code: "654321" }, authorized.binding))._tag,
      ).toBe("BrowserSession");
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );

  it.effect("native email sign-in collects an address without entering hosted AuthKit", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const location = new URL(
        (yield* accounts.authorize({ ...nativeParams, provider: "email" })).location,
        ORIGIN,
      );
      expect(location.origin).toBe(ORIGIN);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("challenge")).toBe(nativeParams.challenge);
      expect(location.searchParams.get("returnUrl")).toBe(nativeParams.returnUrl);
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );
  it.effect("Magic Auth native web returns stay relative despite a supplied origin", () =>
    Effect.gen(function* () {
      const accounts = yield* CloudAccounts.CloudAccounts;
      const authorized = yield* accounts.authorize({
        ...nativeParams,
        provider: "email",
        loginHint: "magic@example.com",
        origin: "https://unregistered.example",
        via: "web",
      });
      const verify = new URL(authorized.location, ORIGIN).searchParams.get("verify") ?? "";
      const result = yield* accounts.verifyEmail({ verify, code: "654321" }, undefined);
      expect(result.location.startsWith("/sign-in?")).toBe(true);
      expect(new URL(result.location, ORIGIN).searchParams.get("handoff")).toBeTruthy();
    }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );
  it.effect(
    "uses the trusted WorkOS realm and hides its personal organization during sign-in",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ url: request.url, authorization: request.headers.authorization });
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.includes("/organizations/external_id/")
                  ? { id: "org_personal_sandbox", external_id: "personal:user_sandbox" }
                  : {
                      data: [
                        { organization_id: "org_sandbox", organization_name: "Test company" },
                        { organization_id: "org_personal_sandbox", organization_name: "Personal" },
                      ],
                      list_metadata: { after: null },
                    },
              ),
            );
          }),
        );
        yield* CloudAccounts.CloudAccounts.use((service) =>
          service.finishSignIn(
            { origin: ORIGIN, codeVerifier: "", target: { mode: "browser", returnTo: "/" } },
            { id: "user_sandbox", email: "richard@piedpiper.example" },
            {
              clientId: "client_sandbox",
              apiKey: Redacted.make("sk_test_sandbox"),
              apiBaseUrl: "https://sandbox.workos.test",
            },
          ),
        ).pipe(
          Effect.provide(
            Layer.fresh(CloudAccounts.layer).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            ),
          ),
        );
        expect(requests).toEqual([
          {
            url: "https://sandbox.workos.test/user_management/organization_memberships",
            authorization: "Bearer sk_test_sandbox",
          },
          {
            url: "https://sandbox.workos.test/organizations/external_id/personal%3Auser_sandbox",
            authorization: "Bearer sk_test_sandbox",
          },
        ]);
        const users = yield* UserDirectory.UserDirectory;
        const shell = yield* users.forUser("user_sandbox").shellSnapshot();
        expect(JSON.stringify(shell)).toContain("org_sandbox");
        expect(JSON.stringify(shell)).not.toContain("org_personal_sandbox");
      }).pipe(Effect.provide(layerAccounts(CODES, withKey))),
  );
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
  /** The sidebar's projects after `user_ada` signs in: one per context. */
  const projectsAfterSignIn = Effect.gen(function* () {
    yield* signIn(browserParams, { code: "code-ada" });
    const users = yield* UserDirectory.UserDirectory;
    const shell = (yield* users.forUser("user_ada").shellSnapshot()) as {
      readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
    };
    return shell.projects.map((project) => `${project.id} ${project.title}`);
  });

  it.effect("signing in shows Personal and every organization the user belongs to", () =>
    Effect.gen(function* () {
      expect(yield* projectsAfterSignIn).toEqual([
        "scratch Scratch",
        "context:org_acme Acme",
        "context:org_globex Globex",
        "context:org_initech Initech",
      ]);
    }).pipe(
      Effect.provide(
        layerAccounts(CODES, withKey, {
          user_ada: [
            { id: "org_initech", name: "Initech" },
            { id: "org_acme", name: "Acme" },
            { id: "org_globex", name: "Globex" },
          ],
        }),
      ),
    ),
  );

  it.effect("without the WorkOS API key, signing in shows Personal only", () =>
    Effect.gen(function* () {
      expect(yield* projectsAfterSignIn).toEqual(["scratch Scratch"]);
    }).pipe(
      Effect.provide(
        layerAccounts(CODES, undefined, { user_ada: [{ id: "org_acme", name: "Acme" }] }),
      ),
    ),
  );
});

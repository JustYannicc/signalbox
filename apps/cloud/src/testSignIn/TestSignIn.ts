import * as AccountFlow from "@signalbox/account/AccountFlow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CloudAccounts from "../account/CloudAccounts.ts";
import type { IdentityProviderUnavailable } from "../account/IdentityProvider.ts";
import * as CloudSessions from "../auth/CloudSessions.ts";
import type { UserObjectError } from "../user/UserDirectory.ts";
import * as TestIdentities from "./TestIdentities.ts";
import * as TestSignInPolicy from "./TestSignInPolicy.ts";

type SignInResult =
  | { readonly mode: "browser" | "token"; readonly token: string; readonly expiresAt: number }
  | { readonly mode: "mobile"; readonly deepLink: string };

export class TestSignInFailed extends Schema.TaggedError<TestSignInFailed>()(
  "TestSignInFailed",
  {},
) {
  override get message() {
    return "Test sign-in failed.";
  }
}

export class TestSignIn extends Context.Service<
  TestSignIn,
  {
    readonly signIn: (input: {
      readonly rawBody: string;
      readonly signature: string | undefined;
      readonly origin: string;
    }) => Effect.Effect<
      SignInResult,
      | TestSignInPolicy.TestSignInDeniedError
      | TestIdentities.TestIdentityUnavailable
      | TestSignInFailed
      | IdentityProviderUnavailable
      | UserObjectError
    >;
  }
>()("@signalbox/cloud/testSignIn/TestSignIn") {}

const make = Effect.gen(function* () {
  const policy = yield* TestSignInPolicy.TestSignInPolicy;
  const identities = yield* TestIdentities.TestIdentities;
  const accounts = yield* CloudAccounts.CloudAccounts;
  const sessions = yield* CloudSessions.CloudSessions;

  const signIn: TestSignIn["Service"]["signIn"] = Effect.fn("TestSignIn.signIn")(function* (input) {
    const request = yield* policy.verify(input.rawBody, input.signature);
    const { user, workos } = yield* identities.resolve(request.user);
    if (request.mode === "browser") {
      const result = yield* accounts.finishSignIn(
        { origin: input.origin, codeVerifier: "", target: { mode: "browser", returnTo: "/" } },
        user,
        workos,
      );
      if (result._tag !== "BrowserSession") return yield* new TestSignInFailed({});
      return { mode: "browser", token: result.token, expiresAt: result.expiresAt };
    }

    const verifier = AccountFlow.randomToken();
    const result = yield* accounts.finishSignIn(
      {
        origin: input.origin,
        codeVerifier: "",
        target: {
          mode: "native",
          returnUrl: "signalbox-dev://account-return",
          challenge: AccountFlow.pkceChallenge(verifier),
        },
      },
      user,
      workos,
    );
    const handoff = new URL(result.location).searchParams.get("handoff");
    if (!handoff) return yield* new TestSignInFailed({});
    const { credential } = yield* accounts
      .redeemHandoff({ handoff, verifier })
      .pipe(Effect.mapError(() => new TestSignInFailed({})));
    if (request.mode === "mobile") {
      // The dev client's existing QR/pairing route consumes this grant once.
      const pairingUrl = new URL(input.origin);
      pairingUrl.hash = new URLSearchParams({ token: credential }).toString();
      const deepLink = new URL("signalbox-dev://connections/new");
      deepLink.searchParams.set("pairingUrl", pairingUrl.toString());
      deepLink.searchParams.set("autoConnect", "1");
      return { mode: "mobile", deepLink: deepLink.toString() };
    }
    const { token, session } = yield* sessions
      .exchangeCredential(credential, {
        method: "bearer-access-token",
        scopes: CloudSessions.CLOUD_SESSION_SCOPES,
        label: user.email,
      })
      .pipe(Effect.mapError(() => new TestSignInFailed({})));
    return { mode: "token", token, expiresAt: session.expiresAt };
  });
  return TestSignIn.of({ signIn });
});

export const layer = Layer.effect(TestSignIn, make);

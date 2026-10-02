import { AuthAdministrativeScopes, type AuthBrowserSessionResult } from "@t3tools/contracts";
import type {
  AccountHandoffRequest,
  AccountHandoffResult,
  AccountProfile,
} from "@t3tools/contracts/account";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as AccountFlow from "./AccountFlow.ts";
import * as AccountHandoffs from "./AccountHandoffs.ts";
import * as AccountRepository from "./AccountRepository.ts";
import type { WorkOSUser } from "./WorkOSClient.ts";

/**
 * Turns a WorkOS-verified user into an environment session: records their
 * profile, then sets a browser session or parks a native handoff. Sessions
 * carry the subject `account:<workos id>`, which is how `/session` finds the
 * profile again.
 */

const ACCOUNT_SUBJECT_PREFIX = "account:";
/** Account credentials are redeemed the moment they are minted. */
const CREDENTIAL_TTL = Duration.minutes(2);

/** A sign-in started by `authorize`, waiting for WorkOS to come back. */
export interface PendingAttempt {
  readonly codeVerifier: string;
  readonly origin: string;
  readonly target: AccountFlow.AccountReturnTarget;
}

/** What the callback route should answer with. Locations may be relative. */
export type AccountCallbackResult =
  | { readonly _tag: "Redirect"; readonly location: string }
  | {
      readonly _tag: "BrowserSession";
      readonly location: string;
      readonly session: {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      };
    };

export const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const profiles = yield* AccountRepository.make;
  const handoffs = AccountHandoffs.makeAccountHandoffs();

  /** A one-time admin pairing credential whose sessions carry `account:<id>`. */
  const mintCredential = (account: AccountProfile) =>
    auth.createPairingLink({
      subject: `${ACCOUNT_SUBJECT_PREFIX}${account.id}`,
      scopes: AuthAdministrativeScopes,
      label: account.email,
      ttl: CREDENTIAL_TTL,
    });

  /** The one success path, shared by the callback and email verification. */
  const finish = Effect.fn("AccountSessions.finish")(function* (
    attempt: PendingAttempt,
    user: WorkOSUser,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const profile = yield* profiles.upsert({
      ...user,
      signedInAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (attempt.target.mode === "browser") {
      const link = yield* mintCredential(profile);
      const session = yield* auth.createBrowserSession(
        link.credential,
        deriveAuthClientMetadata({ request }),
      );
      return {
        _tag: "BrowserSession",
        location: attempt.target.returnTo,
        session,
      } satisfies AccountCallbackResult;
    }
    // Native: no credential until the app proves it holds the verifier.
    const handoff = yield* handoffs.issue({
      account: profile,
      challenge: attempt.target.challenge,
    });
    return {
      _tag: "Redirect",
      location: AccountFlow.nativeReturnLocation(attempt.target, attempt.origin, { handoff }),
    } satisfies AccountCallbackResult;
  });

  const redeem = Effect.fn("AccountSessions.redeem")(function* (body: AccountHandoffRequest) {
    const account = yield* handoffs.redeem(body);
    const link = yield* mintCredential(account);
    return { credential: link.credential, account } satisfies AccountHandoffResult;
  });

  /** The profile behind the request's session, if it is an account session. */
  const accountOf = Effect.fn("AccountSessions.accountOf")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    // Any other session (pairing, desktop bootstrap) or a bad credential is "no account".
    const session = yield* auth
      .authenticateHttpRequest(request)
      .pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
          Effect.succeed(undefined),
        ),
      );
    if (!session?.subject.startsWith(ACCOUNT_SUBJECT_PREFIX)) return undefined;
    return yield* profiles.find(session.subject.slice(ACCOUNT_SUBJECT_PREFIX.length));
  });

  return { finish, redeem, accountOf };
});

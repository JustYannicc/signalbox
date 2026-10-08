import * as AccountFlow from "@signalbox/account/AccountFlow";
import * as WorkOSClient from "@signalbox/account/WorkOSClient";
import type {
  AccountAuthorizeParams,
  AccountHandoffRequest,
  AccountHandoffResult,
  AccountProfile,
  AccountSessionState,
  AccountSignInError,
  AccountVerifyEmailRequest,
} from "@t3tools/contracts/account";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as CloudConfig from "../CloudConfig.ts";
import * as UserDirectory from "../user/UserDirectory.ts";

/**
 * WorkOS sign-in for the cloud, the same flow and routes as a self-hosted
 * server (see docs/internals/accounts.md). What differs is where the state
 * lives: the attempt and a paused email verification are sealed into the
 * values the browser carries, and everything that must be single-use (the
 * native handoff, the credential it yields) is a grant in the user's object.
 */

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const CONTEXTS_SYNC_TIMEOUT = "3 seconds";

export class CloudSignInRequestError extends Schema.TaggedError<CloudSignInRequestError>()(
  "CloudSignInRequestError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Invalid sign-in request: ${this.reason}.`;
  }
}

export class CloudHandoffError extends Schema.TaggedError<CloudHandoffError>()(
  "CloudHandoffError",
  { error: Schema.Literals(["expired", "failed"]) },
) {
  override get message(): string {
    return `The sign-in handoff could not be redeemed (${this.error}).`;
  }
}

export class CloudVerifyEmailError extends Schema.TaggedError<CloudVerifyEmailError>()(
  "CloudVerifyEmailError",
  { error: Schema.Literals(["invalid-code", "expired", "failed"]) },
) {
  override get message(): string {
    return `Email verification failed (${this.error}).`;
  }
}

/** What the callback (or a verified email code) answers with. Locations may be relative. */
export type SignInResult =
  | { readonly _tag: "Redirect"; readonly location: string }
  | {
      readonly _tag: "BrowserSession";
      readonly location: string;
      readonly token: string;
      readonly expiresAt: number;
    };

export interface CallbackInput {
  readonly state?: string;
  readonly code?: string;
  readonly error?: string;
  /** The `SIGN_IN_BINDING_COOKIE` the request carried. */
  readonly binding?: string;
}

export const SIGN_IN_BINDING_COOKIE = "signalbox_cloud_signin";

/** A browser attempt finishes only in the browser holding its binding cookie. */
const boundToRequest = (attempt: CloudTokens.PendingAttempt, binding: string | undefined) =>
  attempt.target.mode !== "browser" ||
  (attempt.binding !== undefined && attempt.binding === binding);

type Credentials = Parameters<CloudSessions.CloudSessions["Service"]["authenticate"]>[0];

export class CloudAccounts extends Context.Service<
  CloudAccounts,
  {
    readonly sessionState: (
      credentials: Credentials,
    ) => Effect.Effect<AccountSessionState, UserDirectory.UserObjectError>;
    /**
     * The WorkOS URL to send the browser to. Browser mode also returns the
     * binding the route sets as `SIGN_IN_BINDING_COOKIE`.
     */
    readonly authorize: (
      params: AccountAuthorizeParams,
    ) => Effect.Effect<
      { readonly location: string; readonly binding?: string },
      CloudSignInRequestError
    >;
    /** Never fails for sign-in problems; those become error redirects. */
    readonly callback: (input: CallbackInput) => Effect.Effect<SignInResult>;
    readonly verifyEmail: (
      body: AccountVerifyEmailRequest,
      binding: string | undefined,
    ) => Effect.Effect<SignInResult, CloudVerifyEmailError>;
    readonly redeemHandoff: (
      body: AccountHandoffRequest,
    ) => Effect.Effect<AccountHandoffResult, CloudHandoffError>;
    /** Revokes the session behind `credentials`. */
    readonly signOut: (
      credentials: Credentials,
    ) => Effect.Effect<void, CloudSessions.CloudCredentialError | UserDirectory.UserObjectError>;
    /**
     * Makes the user's work contexts their WorkOS memberships now: what a
     * membership webhook triggers. Leaving an organization takes its threads
     * and drives out of reach at once (`UserDrives`).
     */
    readonly refreshContexts: (
      userId: string,
    ) => Effect.Effect<void, WorkOSClient.WorkOSOrganizationsError | UserDirectory.UserObjectError>;
  }
>()("@signalbox/cloud/account/CloudAccounts") {}

const toProfile = (user: WorkOSClient.WorkOSUser): AccountProfile => ({ ...user });

const isWorkOSAuthenticateError = Schema.is(WorkOSClient.WorkOSAuthenticateError);

/** Tags and WorkOS codes only: causes can carry request bodies and tokens. */
const logSignInFailure = (error: { readonly _tag: string }) =>
  Effect.logWarning("cloud sign-in failed", {
    errorTag: error._tag,
    ...(isWorkOSAuthenticateError(error)
      ? { status: error.status, workosError: error.error, workosCode: error.code }
      : {}),
  });

const make = Effect.gen(function* () {
  const { accounts } = yield* CloudConfig.CloudConfig;
  const { workos, providers } = accounts;
  const tokens = yield* CloudTokens.CloudTokens;
  const sessions = yield* CloudSessions.CloudSessions;
  const users = yield* UserDirectory.UserDirectory;
  const httpClient = yield* HttpClient.HttpClient;

  const workosAuthenticate = (grant: WorkOSClient.WorkOSGrant) =>
    WorkOSClient.authenticate(workos, grant).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  /**
   * Refreshes the user's work contexts from their WorkOS memberships. Best
   * effort: a failure keeps the contexts from the previous sign-in, and
   * without the API key there are no work contexts at all.
   */
  /**
   * Makes the user's work contexts their WorkOS memberships now. Without the
   * API key there are no work contexts to refresh.
   */
  const refreshContexts: CloudAccounts["Service"]["refreshContexts"] = Effect.fn(
    "CloudAccounts.refreshContexts",
  )(function* (userId) {
    const { apiKey } = workos;
    if (apiKey === undefined) return;
    const organizations = yield* WorkOSClient.listOrganizations({ ...workos, apiKey }, userId).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      // Sign-in waits for this, so a slow WorkOS must not hold it up.
      Effect.timeout(CONTEXTS_SYNC_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new WorkOSClient.WorkOSOrganizationsError({})),
      }),
    );
    yield* users.forUser(userId).syncOrganizations(organizations);
  });

  /** At sign-in: best effort, so a failure keeps the contexts from the previous one. */
  const syncContexts = (userId: string) =>
    refreshContexts(userId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("cloud contexts sync failed", {
          errorTag: error._tag,
          ...(error._tag === "WorkOSOrganizationsError" ? { status: error.status } : {}),
        }),
      ),
    );

  const redirect = (location: string): SignInResult => ({ _tag: "Redirect", location });
  const errorRedirect = (attempt: CloudTokens.PendingAttempt, error: AccountSignInError) =>
    redirect(AccountFlow.callbackErrorLocation(attempt, error));

  const sessionState: CloudAccounts["Service"]["sessionState"] = Effect.fn(
    "CloudAccounts.sessionState",
  )(function* (credentials) {
    const claims = yield* sessions
      .claims(credentials)
      .pipe(Effect.catchTags({ CloudCredentialError: () => Effect.succeed(null) }));
    if (!claims) return { enabled: true, providers, account: null };
    // One object, two independent reads: ask both at once.
    const userObject = users.forUser(claims.userId);
    const [session, profile] = yield* Effect.all(
      [userObject.findSession(claims.sessionId), userObject.profile()],
      { concurrency: 2 },
    );
    return { enabled: true, providers, account: session ? profile : null };
  });

  const authorize: CloudAccounts["Service"]["authorize"] = Effect.fn("CloudAccounts.authorize")(
    function* (params) {
      if (!providers.includes(params.provider)) {
        return yield* new CloudSignInRequestError({ reason: "provider is not enabled" });
      }
      const validated = AccountFlow.validateAuthorizeParams(params);
      if (Result.isFailure(validated)) {
        return yield* new CloudSignInRequestError({ reason: validated.failure });
      }
      const codeVerifier = AccountFlow.randomToken();
      const binding =
        validated.success.target.mode === "browser" ? AccountFlow.randomToken() : undefined;
      const state = yield* tokens.seal({
        _tag: "attempt",
        attempt: {
          codeVerifier,
          origin: validated.success.origin,
          target: validated.success.target,
          ...(binding ? { binding } : {}),
        },
        exp: (yield* Clock.currentTimeMillis) + ATTEMPT_TTL_MS,
      });
      const location = AccountFlow.buildWorkOSAuthorizeUrl({
        apiBaseUrl: workos.apiBaseUrl,
        clientId: workos.clientId,
        request: validated.success,
        state,
        codeChallenge: AccountFlow.pkceChallenge(codeVerifier),
      });
      return binding ? { location, binding } : { location };
    },
  );

  /** The one success path, shared by the callback and email verification. */
  const finish = Effect.fn("CloudAccounts.finish")(function* (
    attempt: CloudTokens.PendingAttempt,
    user: WorkOSClient.WorkOSUser,
  ) {
    const userObject = users.forUser(user.id);
    // Contexts are refreshed alongside the profile, so the first shell after
    // signing in already shows every organization.
    const recordSignIn = Effect.all(
      [userObject.recordSignIn(toProfile(user)), syncContexts(user.id)],
      { concurrency: 2, discard: true },
    );
    if (attempt.target.mode === "browser") {
      const [, { session, token }] = yield* Effect.all(
        [
          recordSignIn,
          sessions.create({ userId: user.id, method: "browser-session-cookie", label: user.email }),
        ],
        { concurrency: 2 },
      );
      return {
        _tag: "BrowserSession",
        location: attempt.target.returnTo,
        token,
        expiresAt: session.expiresAt,
      } satisfies SignInResult;
    }
    // Native: no credential until the app proves it holds the verifier.
    const [, grant] = yield* Effect.all(
      [
        recordSignIn,
        userObject.issueGrant({
          kind: "handoff",
          challenge: attempt.target.challenge,
          ttlMs: HANDOFF_TTL_MS,
        }),
      ],
      { concurrency: 2 },
    );
    const handoff = yield* tokens.sign({
      _tag: "handoff",
      u: user.id,
      gid: grant.gid,
      exp: grant.expiresAt,
    });
    return redirect(AccountFlow.nativeReturnLocation(attempt.target, attempt.origin, { handoff }));
  });

  /** WorkOS asked for an emailed code: park the sign-in in a sealed id for the page. */
  const pauseForEmail = Effect.fn("CloudAccounts.pauseForEmail")(function* (
    attempt: CloudTokens.PendingAttempt,
    required: WorkOSClient.WorkOSEmailVerificationRequired,
  ) {
    // The verification grant needs the client secret, so without the API key
    // the code page could never succeed.
    if (workos.apiKey === undefined) {
      yield* Effect.logError(
        "WorkOS requires T3CODE_WORKOS_API_KEY to finish email verification for this provider",
      );
      return errorRedirect(attempt, "failed");
    }
    const verify = yield* tokens.seal({
      _tag: "verification",
      attempt,
      pendingToken: Redacted.value(required.pendingToken),
      email: required.email,
      exp: (yield* Clock.currentTimeMillis) + VERIFICATION_TTL_MS,
    });
    return redirect(AccountFlow.verifyEmailLocation(attempt.origin, verify, required.email));
  });

  const callback: CloudAccounts["Service"]["callback"] = Effect.fn("CloudAccounts.callback")(
    function* (input) {
      const sealed = input.state
        ? yield* tokens
            .open("attempt", input.state)
            .pipe(Effect.catchTags({ CloudTokenInvalidError: () => Effect.succeed(null) }))
        : null;
      // Unreadable state has nowhere better to report than the sign-in page.
      if (!sealed) return redirect(AccountFlow.expiredCallbackLocation(undefined));
      const { attempt } = sealed;
      if (sealed.exp <= (yield* Clock.currentTimeMillis)) return errorRedirect(attempt, "expired");
      if (!boundToRequest(attempt, input.binding)) return errorRedirect(attempt, "failed");
      if (input.error !== undefined) {
        return errorRedirect(attempt, input.error === "access_denied" ? "cancelled" : "failed");
      }
      if (!input.code) return errorRedirect(attempt, "failed");
      return yield* workosAuthenticate({
        kind: "authorization-code",
        code: input.code,
        codeVerifier: attempt.codeVerifier,
      }).pipe(
        Effect.flatMap((user) => finish(attempt, user)),
        Effect.catchTags({
          WorkOSEmailVerificationRequired: (required) => pauseForEmail(attempt, required),
        }),
        Effect.catch((error) =>
          logSignInFailure(error).pipe(Effect.as(errorRedirect(attempt, "failed"))),
        ),
      );
    },
  );

  const verifyEmail: CloudAccounts["Service"]["verifyEmail"] = Effect.fn(
    "CloudAccounts.verifyEmail",
  )(function* (body, binding) {
    const expired = () => new CloudVerifyEmailError({ error: "expired" });
    const pending = yield* tokens.open("verification", body.verify).pipe(Effect.mapError(expired));
    if (pending.exp <= (yield* Clock.currentTimeMillis)) return yield* expired();
    if (!boundToRequest(pending.attempt, binding)) {
      return yield* new CloudVerifyEmailError({ error: "failed" });
    }
    // WorkOS keeps the pending token alive across wrong codes and rate-limits
    // them, so a sealed id can be retried without a local failure count.
    const user = yield* workosAuthenticate({
      kind: "email-verification",
      code: body.code,
      pendingToken: Redacted.make(pending.pendingToken),
    }).pipe(
      Effect.tapError(logSignInFailure),
      Effect.mapError(
        (error) =>
          new CloudVerifyEmailError({
            error: WorkOSClient.classifyEmailVerificationFailure(error),
          }),
      ),
    );
    return yield* finish(pending.attempt, user).pipe(
      Effect.mapError(() => new CloudVerifyEmailError({ error: "failed" })),
    );
  });

  const redeemHandoff: CloudAccounts["Service"]["redeemHandoff"] = Effect.fn(
    "CloudAccounts.redeemHandoff",
  )(function* (body) {
    const claims = yield* tokens
      .verify("handoff", body.handoff)
      .pipe(Effect.mapError(() => new CloudHandoffError({ error: "expired" })));
    const redemption = yield* users
      .forUser(claims.u)
      .redeemHandoff({
        gid: claims.gid,
        challenge: AccountFlow.pkceChallenge(body.verifier),
        credentialTtlMs: CloudSessions.CREDENTIAL_TTL_MS,
      })
      .pipe(Effect.mapError(() => new CloudHandoffError({ error: "failed" })));
    switch (redemption._tag) {
      case "expired":
        return yield* new CloudHandoffError({ error: "expired" });
      case "rejected":
        return yield* new CloudHandoffError({ error: "failed" });
      case "redeemed": {
        const credential = yield* sessions.signCredential({
          userId: claims.u,
          gid: redemption.credential.gid,
          expiresAt: redemption.credential.expiresAt,
        });
        return { credential, account: redemption.profile };
      }
    }
  });

  const signOut: CloudAccounts["Service"]["signOut"] = Effect.fn("CloudAccounts.signOut")(
    function* (credentials) {
      yield* sessions.revoke(credentials);
    },
  );

  return CloudAccounts.of({
    sessionState,
    authorize,
    callback,
    verifyEmail,
    redeemHandoff,
    signOut,
    refreshContexts,
  });
});

export const layer = Layer.effect(CloudAccounts, make);

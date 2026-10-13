import type {
  AccountAuthorizeParams,
  AccountHandoffRequest,
  AccountHandoffResult,
  AccountSessionState,
  AccountSignInError,
  AccountVerifyEmailRequest,
} from "@t3tools/contracts/account";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AccountConfig from "@signalbox/account/AccountConfig";
import * as AccountFlow from "@signalbox/account/AccountFlow";
import type * as AccountHandoffs from "./AccountHandoffs.ts";
import type * as AccountRepository from "./AccountRepository.ts";
import * as AccountSessions from "./AccountSessions.ts";
import * as AccountVerifications from "./AccountVerifications.ts";
import { makeExpiringStore } from "./ExpiringStore.ts";
import * as WorkOSClient from "@signalbox/account/WorkOSClient";

const ATTEMPT_TTL = Duration.minutes(10);
const MAX_PENDING_ATTEMPTS = 1_000;

export class AccountDisabledError extends Schema.TaggedError<AccountDisabledError>()(
  "AccountDisabledError",
  {},
) {
  override get message(): string {
    return "Signalbox accounts are not configured on this server.";
  }
}

export class AccountInvalidRequestError extends Schema.TaggedError<AccountInvalidRequestError>()(
  "AccountInvalidRequestError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Invalid sign-in request: ${this.reason}.`;
  }
}

export interface AccountCallbackInput {
  readonly state?: string;
  readonly code?: string;
  readonly error?: string;
}

type Request = HttpServerRequest.HttpServerRequest;
type CallbackResult = AccountSessions.AccountCallbackResult;
type InternalError =
  | EnvironmentAuth.ServerAuthInternalError
  | AccountRepository.AccountRepositoryError;

export class AccountService extends Context.Service<
  AccountService,
  {
    readonly sessionState: (request: Request) => Effect.Effect<AccountSessionState, InternalError>;
    /** Returns the WorkOS URL to redirect to. */
    readonly authorize: (
      params: AccountAuthorizeParams,
    ) => Effect.Effect<string, AccountDisabledError | AccountInvalidRequestError>;
    /** Never fails for sign-in problems; those become error redirects. */
    readonly callback: (
      input: AccountCallbackInput,
      request: Request,
    ) => Effect.Effect<CallbackResult, AccountDisabledError>;
    /** Finishes a sign-in paused for email verification, as the callback would have. */
    readonly verifyEmail: (
      body: AccountVerifyEmailRequest,
      request: Request,
    ) => Effect.Effect<
      CallbackResult,
      | AccountDisabledError
      | AccountVerifications.AccountVerificationExpiredError
      | AccountVerifications.AccountVerificationCodeRejectedError
      | WorkOSClient.WorkOSAuthenticateError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | InternalError
    >;
    readonly redeemHandoff: (
      body: AccountHandoffRequest,
    ) => Effect.Effect<
      AccountHandoffResult,
      | AccountDisabledError
      | AccountHandoffs.AccountHandoffNotFoundError
      | AccountHandoffs.AccountHandoffRejectedError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Revokes the session that made `request`. */
    readonly signOut: (
      request: Request,
    ) => Effect.Effect<
      void,
      | AccountDisabledError
      | EnvironmentAuth.ServerAuthCredentialError
      | EnvironmentAuth.ServerAuthInternalError
    >;
  }
>()("t3/account/AccountService") {}

const isWorkOSAuthenticateError = Schema.is(WorkOSClient.WorkOSAuthenticateError);

/** Tags and WorkOS codes only: causes can carry request bodies and tokens. */
const logSignInFailure = (error: { readonly _tag: string }) =>
  Effect.logWarning("account sign-in failed", {
    errorTag: error._tag,
    ...(isWorkOSAuthenticateError(error)
      ? { status: error.status, workosError: error.error, workosCode: error.code }
      : {}),
  });

const make = Effect.gen(function* () {
  const config = yield* AccountConfig.read.pipe(Effect.orDie);
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const sessions = yield* AccountSessions.make.pipe(Effect.orDie);
  const attempts = makeExpiringStore<AccountSessions.PendingAttempt>({
    ttl: ATTEMPT_TTL,
    maxEntries: MAX_PENDING_ATTEMPTS,
  });
  const verifications =
    AccountVerifications.makeAccountVerifications<AccountSessions.PendingAttempt>();

  const requireConfig = config ? Effect.succeed(config) : Effect.fail(new AccountDisabledError());
  const workosAuthenticate = (workos: WorkOSClient.WorkOSConfig, grant: WorkOSClient.WorkOSGrant) =>
    WorkOSClient.authenticate(workos, grant).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const sessionState: AccountService["Service"]["sessionState"] = Effect.fn(
    "AccountService.sessionState",
  )(function* (request) {
    if (!config) return { enabled: false, providers: [], account: null };
    const account = yield* sessions.accountOf(request);
    return { enabled: true, providers: config.providers, account: account ?? null };
  });

  const authorize: AccountService["Service"]["authorize"] = Effect.fn("AccountService.authorize")(
    function* (params) {
      const { workos, providers } = yield* requireConfig;
      if (!providers.includes(params.provider)) {
        return yield* new AccountInvalidRequestError({ reason: "provider is not enabled" });
      }
      const validated = AccountFlow.validateAuthorizeParams(params);
      if (Result.isFailure(validated)) {
        return yield* new AccountInvalidRequestError({ reason: validated.failure });
      }
      const state = AccountFlow.attemptState(validated.success.target);
      const codeVerifier = AccountFlow.randomToken();
      yield* attempts.put(state, {
        codeVerifier,
        origin: validated.success.origin,
        target: validated.success.target,
      });
      return AccountFlow.buildWorkOSAuthorizeUrl({
        apiBaseUrl: workos.apiBaseUrl,
        clientId: workos.clientId,
        request: validated.success,
        state,
        codeChallenge: AccountFlow.pkceChallenge(codeVerifier),
      });
    },
  );

  const redirect = (location: string): CallbackResult => ({ _tag: "Redirect", location });
  const errorRedirect = (attempt: AccountSessions.PendingAttempt, error: AccountSignInError) =>
    redirect(AccountFlow.callbackErrorLocation(attempt, error));

  const callback: AccountService["Service"]["callback"] = Effect.fn("AccountService.callback")(
    function* (input, request) {
      const { workos } = yield* requireConfig;
      const attempt = input.state ? yield* attempts.take(input.state) : undefined;
      if (!attempt) return redirect(AccountFlow.expiredCallbackLocation(input.state));
      if (input.error !== undefined) {
        return errorRedirect(attempt, input.error === "access_denied" ? "cancelled" : "failed");
      }
      if (!input.code) return errorRedirect(attempt, "failed");
      return yield* workosAuthenticate(workos, {
        kind: "authorization-code",
        code: input.code,
        codeVerifier: attempt.codeVerifier,
      }).pipe(
        Effect.flatMap((user) => sessions.finish(attempt, user, request)),
        // WorkOS emailed a code (e.g. GitHub emails are not trusted): the
        // sign-in page collects it, in every mode.
        Effect.catchTags({
          WorkOSEmailVerificationRequired: (required) =>
            // The verification grant needs the client secret, so without the API
            // key the code page could never succeed.
            workos.apiKey === undefined
              ? Effect.logError(
                  "WorkOS requires T3CODE_WORKOS_API_KEY to finish email verification for this provider",
                ).pipe(Effect.as(errorRedirect(attempt, "failed")))
              : verifications
                  .issue({ pendingToken: required.pendingToken, email: required.email, attempt })
                  .pipe(
                    Effect.map((id) =>
                      redirect(AccountFlow.verifyEmailLocation(attempt.origin, id, required.email)),
                    ),
                  ),
        }),
        Effect.catch((error) =>
          logSignInFailure(error).pipe(Effect.as(errorRedirect(attempt, "failed"))),
        ),
      );
    },
  );

  const verifyEmail: AccountService["Service"]["verifyEmail"] = Effect.fn(
    "AccountService.verifyEmail",
  )(function* (body, request) {
    const { workos } = yield* requireConfig;
    const { user, attempt } = yield* verifications
      .verify(body.verify, (pendingToken) =>
        workosAuthenticate(workos, { kind: "email-verification", code: body.code, pendingToken }),
      )
      .pipe(Effect.tapError(logSignInFailure));
    return yield* sessions.finish(attempt, user, request);
  });

  const redeemHandoff: AccountService["Service"]["redeemHandoff"] = Effect.fn(
    "AccountService.redeemHandoff",
  )(function* (body) {
    yield* requireConfig;
    return yield* sessions.redeem(body);
  });

  const signOut: AccountService["Service"]["signOut"] = Effect.fn("AccountService.signOut")(
    function* (request) {
      yield* requireConfig;
      const session = yield* auth.authenticateHttpRequest(request);
      yield* auth.revokeSession(session.sessionId);
    },
  );

  return AccountService.of({
    sessionState,
    authorize,
    callback,
    verifyEmail,
    redeemHandoff,
    signOut,
  });
});

export const layer = Layer.effect(AccountService, make);

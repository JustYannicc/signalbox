import {
  ACCOUNT_AUTHORIZE_PATH,
  ACCOUNT_CALLBACK_PATH,
  ACCOUNT_HANDOFF_PATH,
  ACCOUNT_SESSION_PATH,
  ACCOUNT_SIGN_OUT_PATH,
  ACCOUNT_VERIFY_EMAIL_PATH,
  AccountAuthorizeParams,
  type AccountHandoffFailure,
  AccountHandoffRequest,
  type AccountVerifyEmailFailure,
  AccountVerifyEmailRequest,
} from "@t3tools/contracts/account";
import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as CloudAccounts from "../account/CloudAccounts.ts";
import {
  expiredSessionCookie,
  NO_STORE_HEADERS,
  requestCredentials,
  sessionCookie,
  signInBindingCookie,
  traceId,
} from "./credentials.ts";

/**
 * `/api/account/*`, the same raw routes a self-hosted server exposes (see
 * `apps/server/src/account/http.ts`). Each decodes, calls one CloudAccounts
 * method, and maps errors to the contract's failure bodies.
 */

const NO_STORE = NO_STORE_HEADERS;

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: NO_STORE });
const internalError = (cause: unknown) =>
  Effect.logError("cloud account route failed", { cause }).pipe(
    Effect.as(text("Internal Server Error", 500)),
  );

const decodeAuthorizeParams = Schema.decodeUnknownEffect(AccountAuthorizeParams);

const requestQuery = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.match(HttpServerRequest.toURL(request), {
    onNone: () => ({}) as Record<string, string>,
    onSome: (url) => Object.fromEntries(url.searchParams),
  }),
);

const requestCredentialsEffect = Effect.map(
  HttpServerRequest.HttpServerRequest,
  requestCredentials,
);

const sessionRoute = HttpRouter.add(
  "GET",
  ACCOUNT_SESSION_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const state = yield* accounts.sessionState(yield* requestCredentialsEffect);
    return HttpServerResponse.jsonUnsafe(state, { headers: NO_STORE });
  }).pipe(Effect.catch(internalError)),
);

const authorizeRoute = HttpRouter.add(
  "GET",
  ACCOUNT_AUTHORIZE_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const params = yield* requestQuery.pipe(Effect.flatMap(decodeAuthorizeParams));
    const { location, binding } = yield* accounts.authorize(params);
    const cookies = binding
      ? yield* signInBindingCookie(CloudAccounts.SIGN_IN_BINDING_COOKIE, binding)
      : undefined;
    return HttpServerResponse.redirect(location, {
      headers: NO_STORE,
      ...(cookies ? { cookies } : {}),
    });
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(text("Invalid sign-in request.", 400)),
      CloudSignInRequestError: (error) => Effect.succeed(text(error.message, 400)),
      CookiesError: internalError,
    }),
  ),
);

/** A sign-in result as a response: a redirect, or the `next` body for the code page. */
const respondWith = (
  result: CloudAccounts.SignInResult,
  render: (location: string) => HttpServerResponse.HttpServerResponse,
) =>
  result._tag === "BrowserSession"
    ? sessionCookie(result.token, result.expiresAt).pipe(
        Effect.map((cookies) => HttpServerResponse.mergeCookies(render(result.location), cookies)),
      )
    : Effect.succeed(render(result.location));

const requestBinding = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request): string | undefined => request.cookies[CloudAccounts.SIGN_IN_BINDING_COOKIE],
);

const callbackRoute = HttpRouter.add(
  "GET",
  ACCOUNT_CALLBACK_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const query = yield* requestQuery;
    const binding = yield* requestBinding;
    const result = yield* accounts.callback({
      ...(query.state ? { state: query.state } : {}),
      ...(query.code ? { code: query.code } : {}),
      ...(query.error ? { error: query.error } : {}),
      ...(binding ? { binding } : {}),
    });
    return yield* respondWith(result, (location) =>
      HttpServerResponse.redirect(location, { headers: NO_STORE }),
    );
  }).pipe(Effect.catchTags({ CookiesError: internalError })),
);

const handoffFailure = (error: AccountHandoffFailure["error"], status: number) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE }));

const handoffRoute = HttpRouter.add(
  "POST",
  ACCOUNT_HANDOFF_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const body = yield* HttpServerRequest.schemaBodyJson(AccountHandoffRequest);
    const result = yield* accounts.redeemHandoff(body);
    return HttpServerResponse.jsonUnsafe(result, { headers: NO_STORE });
  }).pipe(
    // Every failure body is an AccountHandoffFailure; details stay in logs.
    Effect.catchTags({
      SchemaError: () => handoffFailure("failed", 400),
      HttpServerError: () => handoffFailure("failed", 400),
      CloudHandoffError: (error) =>
        handoffFailure(error.error, error.error === "expired" ? 404 : 400),
    }),
  ),
);

const verifyFailure = (error: AccountVerifyEmailFailure["error"], status: number) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE }));

const VERIFY_FAILURE_STATUS = { "invalid-code": 400, expired: 404, failed: 500 } as const;

const verifyEmailRoute = HttpRouter.add(
  "POST",
  ACCOUNT_VERIFY_EMAIL_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    const body = yield* HttpServerRequest.schemaBodyJson(AccountVerifyEmailRequest);
    const result = yield* accounts.verifyEmail(body, yield* requestBinding);
    return yield* respondWith(result, (next) =>
      HttpServerResponse.jsonUnsafe({ next }, { headers: NO_STORE }),
    );
  }).pipe(
    // Every failure body is an AccountVerifyEmailFailure; details stay in logs.
    Effect.catchTags({
      SchemaError: () => verifyFailure("failed", 400),
      HttpServerError: () => verifyFailure("failed", 400),
      CloudVerifyEmailError: (error) =>
        verifyFailure(error.error, VERIFY_FAILURE_STATUS[error.error]),
      CookiesError: (cause) =>
        Effect.logError("cloud email verification failed", { cause }).pipe(
          Effect.andThen(verifyFailure("failed", 500)),
        ),
    }),
  ),
);

const signOutRoute = HttpRouter.add(
  "POST",
  ACCOUNT_SIGN_OUT_PATH,
  Effect.gen(function* () {
    const accounts = yield* CloudAccounts.CloudAccounts;
    yield* accounts.signOut(yield* requestCredentialsEffect);
    const cookies = yield* expiredSessionCookie;
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE, cookies });
  }).pipe(
    Effect.catchTags({
      CloudCredentialError: (error) =>
        traceId.pipe(
          Effect.flatMap((id) =>
            HttpServerRespondable.toResponse(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: error.reason,
                traceId: id,
              }),
            ),
          ),
        ),
      UserObjectError: internalError,
      CookiesError: internalError,
    }),
  ),
);

export const layer = Layer.mergeAll(
  sessionRoute,
  authorizeRoute,
  callbackRoute,
  handoffRoute,
  verifyEmailRoute,
  signOutRoute,
);

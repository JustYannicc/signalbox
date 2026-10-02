import {
  ACCOUNT_AUTHORIZE_PATH,
  ACCOUNT_CALLBACK_PATH,
  ACCOUNT_HANDOFF_PATH,
  ACCOUNT_SESSION_PATH,
  ACCOUNT_SIGN_OUT_PATH,
  ACCOUNT_VERIFY_EMAIL_PATH,
  AccountAuthorizeParams,
  AccountHandoffRequest,
  type AccountHandoffFailure,
  AccountVerifyEmailRequest,
  type AccountVerifyEmailFailure,
} from "@t3tools/contracts/account";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AccountService from "./AccountService.ts";
import type * as AccountSessions from "./AccountSessions.ts";

/**
 * Raw `/api/account/*` routes. Each decodes, calls one AccountService method,
 * and maps errors. CORS comes from the router-wide `browserApiCorsLayer`.
 */

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;
const COOKIE_OPTIONS = { httpOnly: true, path: "/", sameSite: "lax" } as const;

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: NO_STORE });
const notFound = () => text("Not Found", 404);
const internalError = (cause: unknown) =>
  Effect.logError("account route failed", { cause }).pipe(
    Effect.as(text("Internal Server Error", 500)),
  );

const decodeAuthorizeParams = Schema.decodeUnknownEffect(AccountAuthorizeParams);

const requestQuery = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.match(HttpServerRequest.toURL(request), {
    onNone: () => ({}) as Record<string, string>,
    onSome: (url) => Object.fromEntries(url.searchParams),
  }),
);

const sessionRoute = HttpRouter.add(
  "GET",
  ACCOUNT_SESSION_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const state = yield* accounts.sessionState(request);
    return HttpServerResponse.jsonUnsafe(state, { headers: NO_STORE });
  }).pipe(Effect.catch(internalError)),
);

const authorizeRoute = HttpRouter.add(
  "GET",
  ACCOUNT_AUTHORIZE_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const params = yield* requestQuery.pipe(Effect.flatMap(decodeAuthorizeParams));
    const location = yield* accounts.authorize(params);
    return HttpServerResponse.redirect(location, { headers: NO_STORE });
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(text("Invalid sign-in request.", 400)),
      AccountInvalidRequestError: (error) => Effect.succeed(text(error.message, 400)),
      AccountDisabledError: () => Effect.succeed(notFound()),
    }),
  ),
);

const browserSessionCookies = Effect.fn("account.browserSessionCookies")(function* (
  session: Extract<AccountSessions.AccountCallbackResult, { _tag: "BrowserSession" }>["session"],
) {
  // Mirrors the `browserSession` handler in auth/http.ts.
  const sessions = yield* SessionStore.SessionStore;
  const selected = yield* Effect.fromResult(
    Cookies.set(Cookies.empty, session.cookieName ?? sessions.cookieName, session.sessionToken, {
      ...COOKIE_OPTIONS,
      expires: DateTime.toDate(session.response.expiresAt),
    }),
  );
  return session.expireNormalCookie
    ? yield* Effect.fromResult(Cookies.expireCookie(selected, sessions.cookieName, COOKIE_OPTIONS))
    : selected;
});

const callbackRoute = HttpRouter.add(
  "GET",
  ACCOUNT_CALLBACK_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* requestQuery;
    const result = yield* accounts.callback(
      {
        ...(query.state ? { state: query.state } : {}),
        ...(query.code ? { code: query.code } : {}),
        ...(query.error ? { error: query.error } : {}),
      },
      request,
    );
    const cookies =
      result._tag === "BrowserSession" ? yield* browserSessionCookies(result.session) : undefined;
    return HttpServerResponse.redirect(result.location, {
      headers: NO_STORE,
      ...(cookies ? { cookies } : {}),
    });
  }).pipe(
    Effect.catchTags({
      AccountDisabledError: () => Effect.succeed(notFound()),
      CookiesError: internalError,
    }),
  ),
);

const handoffFailure = (error: AccountHandoffFailure["error"], status: number) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE }));

const handoffRoute = HttpRouter.add(
  "POST",
  ACCOUNT_HANDOFF_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const body = yield* HttpServerRequest.schemaBodyJson(AccountHandoffRequest);
    const result = yield* accounts.redeemHandoff(body);
    return HttpServerResponse.jsonUnsafe(result, { headers: NO_STORE });
  }).pipe(
    // Every failure body is an AccountHandoffFailure; details stay in logs.
    Effect.catchTags({
      SchemaError: () => handoffFailure("failed", 400),
      HttpServerError: () => handoffFailure("failed", 400),
      AccountHandoffRejectedError: () => handoffFailure("failed", 400),
      AccountHandoffNotFoundError: () => handoffFailure("expired", 404),
      AccountDisabledError: () => handoffFailure("failed", 404),
    }),
    Effect.catch((cause) =>
      Effect.logError("account handoff failed", { cause }).pipe(
        Effect.andThen(handoffFailure("failed", 500)),
      ),
    ),
  ),
);

const verifyFailure = (error: AccountVerifyEmailFailure["error"], status: number) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE }));

const verifyEmailRoute = HttpRouter.add(
  "POST",
  ACCOUNT_VERIFY_EMAIL_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* HttpServerRequest.schemaBodyJson(AccountVerifyEmailRequest);
    const result = yield* accounts.verifyEmail(body, request);
    const cookies =
      result._tag === "BrowserSession" ? yield* browserSessionCookies(result.session) : undefined;
    return HttpServerResponse.jsonUnsafe(
      { next: result.location },
      { headers: NO_STORE, ...(cookies ? { cookies } : {}) },
    );
  }).pipe(
    // Every failure body is an AccountVerifyEmailFailure; details stay in logs.
    Effect.catchTags({
      SchemaError: () => verifyFailure("failed", 400),
      HttpServerError: () => verifyFailure("failed", 400),
      AccountVerificationCodeRejectedError: () => verifyFailure("invalid-code", 400),
      AccountVerificationExpiredError: () => verifyFailure("expired", 404),
      AccountDisabledError: () => verifyFailure("failed", 404),
    }),
    Effect.catch((cause) =>
      Effect.logError("account email verification failed", { cause }).pipe(
        Effect.andThen(verifyFailure("failed", 500)),
      ),
    ),
  ),
);

const signOutRoute = HttpRouter.add(
  "POST",
  ACCOUNT_SIGN_OUT_PATH,
  Effect.gen(function* () {
    const accounts = yield* AccountService.AccountService;
    const sessions = yield* SessionStore.SessionStore;
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* accounts.signOut(request);
    let cookies = yield* Effect.fromResult(
      Cookies.expireCookie(Cookies.empty, sessions.cookieName, COOKIE_OPTIONS),
    );
    if (sessions.legacyCookieName) {
      cookies = yield* Effect.fromResult(
        Cookies.expireCookie(cookies, sessions.legacyCookieName, COOKIE_OPTIONS),
      );
    }
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE, cookies });
  }).pipe(
    // Same error bodies as the other authenticated raw routes in ../http.ts.
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("client_session_revoke_failed", error),
    ),
    Effect.catchTags({
      AccountDisabledError: () => Effect.succeed(notFound()),
      CookiesError: internalError,
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Every account route plus the one AccountService instance they share. */
export const layer = Layer.mergeAll(
  sessionRoute,
  authorizeRoute,
  callbackRoute,
  handoffRoute,
  verifyEmailRoute,
  signOutRoute,
).pipe(
  // Route handlers resolve services per request; a plain Layer.provide would
  // only reach the route registration. Built once, so attempts are shared.
  HttpRouter.provideRequest(AccountService.layer),
);

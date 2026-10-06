import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cookies from "effect/http/Cookies";
import { HttpServerRequest } from "effect/http";

import { SESSION_COOKIE_NAME } from "../environment.ts";

/** Credential-bearing responses are never cached. */
export const NO_STORE_HEADERS = { "cache-control": "no-store", pragma: "no-cache" } as const;

/** The session credentials a request presents: the cloud's cookie, and a bearer token. */
export function requestCredentials(request: HttpServerRequest.HttpServerRequest) {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
  return { cookie: request.cookies[SESSION_COOKIE_NAME], bearer: bearer || undefined };
}

/** `Secure` everywhere but plain-http local development. */
function cookieOptions(request: HttpServerRequest.HttpServerRequest) {
  const secure = Option.match(HttpServerRequest.toURL(request), {
    onNone: () => true,
    onSome: (url) => url.protocol === "https:",
  });
  return { httpOnly: true, path: "/", sameSite: "lax", secure } as const;
}

/** The session cookie for `token`, for the current request's origin. */
export const sessionCookie = (token: string, expiresAt: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.fromResult(
      Cookies.set(Cookies.empty, SESSION_COOKIE_NAME, token, {
        ...cookieOptions(request),
        expires: DateTime.toDate(DateTime.makeUnsafe(expiresAt)),
      }),
    );
  });

/** Clears the session cookie (sign-out). */
export const expiredSessionCookie = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* Effect.fromResult(
    Cookies.expireCookie(Cookies.empty, SESSION_COOKIE_NAME, cookieOptions(request)),
  );
});

/**
 * Ties a browser sign-in to the browser that started it (`authorize` to
 * `callback`, and the emailed-code step in between). Scoped to the account
 * routes and only as long-lived as the attempt.
 */
export const signInBindingCookie = (name: string, binding: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.fromResult(
      Cookies.set(Cookies.empty, name, binding, {
        ...cookieOptions(request),
        path: "/api/account",
        maxAge: "10 minutes",
      }),
    );
  });

/** The request's trace id for error bodies, as the self-hosted server reports it. */
export const traceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

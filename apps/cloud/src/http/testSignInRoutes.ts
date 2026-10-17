import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as TestSignIn from "../testSignIn/TestSignIn.ts";
import { failure, json, requestUrl, sessionCookie } from "./credentials.ts";

export const TEST_SIGN_IN_PATH = "/api/testing/sign-in";

const signIn = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const result = yield* (yield* TestSignIn.TestSignIn).signIn({
    rawBody: yield* request.text,
    signature: request.headers["x-signalbox-test-signature"],
    origin: (yield* requestUrl).origin,
  });
  if (result.mode !== "browser") return json(result, 200);
  const cookies = yield* sessionCookie(result.token, result.expiresAt);
  return HttpServerResponse.mergeCookies(
    json({ mode: "browser", expiresAt: result.expiresAt }, 200),
    cookies,
  );
}).pipe(
  Effect.catchTags({
    TestSignInDeniedError: (error) =>
      failure(
        error.reason,
        error.reason === "not_found" ? 404 : error.reason === "unauthorized" ? 401 : 400,
      ),
    TestIdentityUnavailable: () => failure("test_identity_unavailable", 503),
    TestSignInFailed: () => failure("test_sign_in_failed", 500),
    UserObjectError: () => failure("test_sign_in_failed", 500),
    HttpServerError: () => failure("invalid_request", 400),
    CookiesError: () => failure("test_sign_in_failed", 500),
  }),
);

export const layer = HttpRouter.add("POST", TEST_SIGN_IN_PATH, signIn);

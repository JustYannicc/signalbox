import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as TestSignIn from "../testSignIn/TestSignIn.ts";
import * as TestSignInPolicy from "../testSignIn/TestSignInPolicy.ts";
import { failure, json, requestUrl, sessionCookie } from "./credentials.ts";

export const TEST_SIGN_IN_PATH = "/api/testing/sign-in";

const signIn = Effect.gen(function* () {
  yield* (yield* TestSignInPolicy.TestSignInPolicy).checkEnabled;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(length) || length < 0 || length > TestSignInPolicy.MAX_BODY_BYTES) {
    return yield* failure("invalid_request", 400);
  }
  // Web Request.text() ignores Effect's body-size setting. Bound the stream itself.
  const bytes = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (body, chunk) => {
        if (body.byteLength + chunk.byteLength > TestSignInPolicy.MAX_BODY_BYTES) {
          return Effect.fail(
            new TestSignInPolicy.TestSignInDeniedError({ reason: "invalid_request" }),
          );
        }
        const combined = new Uint8Array(body.byteLength + chunk.byteLength);
        combined.set(body);
        combined.set(chunk, body.byteLength);
        return Effect.succeed(combined);
      },
    ),
  );
  const result = yield* (yield* TestSignIn.TestSignIn).signIn({
    rawBody: new TextDecoder().decode(bytes),
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

/**
 * Opt-in dev auto-auth (`T3CODE_DEV_AUTO_AUTH=true`, resolved in `cli/config.ts`).
 * On a web dev server with the reusable dev credential, a browser that reaches
 * `GET /api/auth/session` without a working session gets the reusable dev
 * session cookie, so the bare dev URL opens straight into the app instead of
 * the pairing screen.
 *
 * Only same-origin reads are upgraded: requests with an `Authorization` header
 * (bearer and DPoP clients) and cross-origin requests, whose cookies the
 * session route would reject anyway, are left alone. If the dev credential was
 * revoked locally, the browser falls back to pairing as usual.
 */
import type { AuthSessionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { resolveReusableDevAuth } from "../auth/ReusableDevAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";

// Browsers omit `Origin` on same-origin GETs; `Sec-Fetch-Site` survives the dev proxy.
const isSameOriginRead = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.origin === undefined || request.headers["sec-fetch-site"] === "same-origin";

type BrowserSession = Effect.Success<
  ReturnType<EnvironmentAuth.EnvironmentAuth["Service"]["createBrowserSession"]>
>;

export const makeDevAutoAuth = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const devAuth = config.devAutoAuth === true ? resolveReusableDevAuth(config) : undefined;

  /** Returns the session state, upgraded to the dev session when auto-auth applies. */
  const upgradeSession = <E, R>(
    request: HttpServerRequest.HttpServerRequest,
    state: AuthSessionState,
    appendBrowserSessionCookies: (session: BrowserSession) => Effect.Effect<void, E, R>,
  ) => {
    if (
      devAuth === undefined ||
      state.authenticated ||
      request.headers.authorization !== undefined ||
      !isSameOriginRead(request)
    ) {
      return Effect.succeed(state);
    }
    return serverAuth
      .createBrowserSession(devAuth.credential, deriveAuthClientMetadata({ request }))
      .pipe(
        Effect.tap(appendBrowserSessionCookies),
        Effect.map((session): AuthSessionState => ({ ...state, ...session.response })),
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () => Effect.succeed(state)),
        Effect.withSpan("signalbox.devAutoAuth.upgradeSession"),
      );
  };

  return { upgradeSession };
});

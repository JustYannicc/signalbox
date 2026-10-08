import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Cookies from "effect/http/Cookies";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { NO_STORE_HEADERS, requestCredentials } from "../http/credentials.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { GitHub } from "./GitHub.ts";

/**
 * Connecting GitHub (#135): `/api/github/connect` starts the App's web flow
 * and `/api/github/callback` finishes it, both in a browser signed in to this
 * cloud. The callback must arrive in the same browser, as the same user, with
 * the one-time grant `connect` set in a cookie; otherwise someone could send a
 * victim a link that attaches the victim's GitHub to the sender's account.
 * `/api/github/disconnect` forgets the connection and revokes it on GitHub,
 * and `/api/github/install` leads to the App's install page.
 *
 * Clients open `connect` in a browser (Settings › Source Control).
 */

const GITHUB_CONNECT_PATH = "/api/github/connect";
const GITHUB_CALLBACK_PATH = "/api/github/callback";
const GITHUB_DISCONNECT_PATH = "/api/github/disconnect";
/** Sends the browser to install the App on more accounts and repositories. */
const GITHUB_INSTALL_PATH = "/api/github/install";

/** Where the browser lands once connected: the web app's Source Control settings. */
const SETTINGS_PATH = "/settings/source-control";
const GRANT_COOKIE = "signalbox_github_connect";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A short page for the browser that opened the flow, when it cannot just go back to the app. */
const page = (status: number, title: string, message: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
      `<p><a href="/">Open Signalbox</a></p></body>`,
    { status, headers: NO_STORE_HEADERS, contentType: "text/html; charset=utf-8" },
  );

const requestUrl = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.getOrThrow(HttpServerRequest.toURL(request)),
);

/** The browser's session, from its cookie only: bearer tokens belong to apps, not to this flow. */
const browserSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { cookie } = requestCredentials(request);
  const sessions = yield* CloudSessions.CloudSessions;
  return yield* sessions.authenticate({ cookie }).pipe(Effect.option);
});

const NOT_CONFIGURED = page(
  503,
  "GitHub isn't set up",
  "This Signalbox Cloud has no GitHub App configured.",
);

const SIGN_IN_FIRST = page(
  401,
  "Sign in first",
  "Sign in to Signalbox Cloud in this browser, then connect GitHub again from Settings.",
);

const grantCookie = (value: string, secure: boolean, expire: boolean) =>
  Effect.fromResult(
    expire
      ? Cookies.expireCookie(Cookies.empty, GRANT_COOKIE, { path: "/api/github", secure })
      : Cookies.set(Cookies.empty, GRANT_COOKIE, value, {
          httpOnly: true,
          path: "/api/github",
          sameSite: "lax",
          secure,
          maxAge: "10 minutes",
        }),
  );

const connectRoute = HttpRouter.add(
  "GET",
  GITHUB_CONNECT_PATH,
  Effect.gen(function* () {
    const session = yield* browserSession;
    if (Option.isNone(session)) return SIGN_IN_FIRST;
    const url = yield* requestUrl;
    const started = yield* (yield* UserDirectory.UserDirectory)
      .forUser(session.value.userId)
      .beginGitHubConnect(`${url.origin}${GITHUB_CALLBACK_PATH}`);
    if (started._tag === "unavailable") {
      return NOT_CONFIGURED;
    }
    const cookies = yield* grantCookie(started.grantId, url.protocol === "https:", false);
    return HttpServerResponse.redirect(started.url, { headers: NO_STORE_HEADERS, cookies });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("github connect failed", { cause }).pipe(
        Effect.as(page(500, "Something went wrong", "Connecting GitHub failed. Try again.")),
      ),
    ),
  ),
);

const callbackRoute = HttpRouter.add(
  "GET",
  GITHUB_CALLBACK_PATH,
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const expired = yield* grantCookie("", url.protocol === "https:", true);
    // Backing out on GitHub's page just goes back to where the user was.
    if (code === null) {
      return HttpServerResponse.redirect(SETTINGS_PATH, {
        headers: NO_STORE_HEADERS,
        cookies: expired,
      });
    }
    const session = yield* browserSession;
    if (Option.isNone(session)) return SIGN_IN_FIRST;
    if (state === "" || request.cookies[GRANT_COOKIE] !== state) {
      return page(
        400,
        "Start again from Signalbox",
        "This GitHub sign-in didn't start in this browser. Connect GitHub again from Settings.",
      );
    }
    const result = yield* (yield* UserDirectory.UserDirectory)
      .forUser(session.value.userId)
      .completeGitHubConnect({
        grantId: state,
        code,
        redirectUri: `${url.origin}${GITHUB_CALLBACK_PATH}`,
      });
    if (result._tag === "failed") return page(400, "GitHub didn't connect", result.reason);
    return HttpServerResponse.redirect(SETTINGS_PATH, {
      headers: NO_STORE_HEADERS,
      cookies: expired,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("github callback failed", { cause }).pipe(
        Effect.as(page(500, "Something went wrong", "Connecting GitHub failed. Try again.")),
      ),
    ),
  ),
);

const disconnectRoute = HttpRouter.add(
  "POST",
  GITHUB_DISCONNECT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const credentials = requestCredentials(request);
    // A cookie is sent with cross-site form posts too; only this origin may use it here.
    if (credentials.bearer === undefined && request.headers["sec-fetch-site"] !== "same-origin") {
      return HttpServerResponse.text("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
    }
    const sessions = yield* CloudSessions.CloudSessions;
    const session = yield* sessions.authenticate(credentials).pipe(Effect.option);
    if (Option.isNone(session)) {
      return HttpServerResponse.text("Unauthorized", { status: 401, headers: NO_STORE_HEADERS });
    }
    yield* (yield* UserDirectory.UserDirectory).forUser(session.value.userId).disconnectGitHub();
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE_HEADERS });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("github disconnect failed", { cause }).pipe(
        Effect.as(
          HttpServerResponse.text("Internal Server Error", {
            status: 500,
            headers: NO_STORE_HEADERS,
          }),
        ),
      ),
    ),
  ),
);

const installRoute = HttpRouter.add(
  "GET",
  GITHUB_INSTALL_PATH,
  Effect.map(GitHub, ({ app, api }) =>
    app === null
      ? NOT_CONFIGURED
      : HttpServerResponse.redirect(api.installUrl(app.slug), { headers: NO_STORE_HEADERS }),
  ),
);

export const layer = Layer.mergeAll(connectRoute, callbackRoute, disconnectRoute, installRoute);

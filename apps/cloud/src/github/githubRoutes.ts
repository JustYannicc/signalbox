import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import { NO_STORE_HEADERS, requestCredentials } from "../http/credentials.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { GRANT_TTL_MS } from "./GitHubConnection.ts";

/**
 * Connecting GitHub: `/api/github/connect` sends the browser to WorkOS Pipes,
 * which runs GitHub's OAuth and comes back to `/api/github/callback`, both in
 * a browser signed in to this cloud. The callback's `state` is a signed
 * token naming the user and the attempt's grant. Back in a browser signed in
 * as that user, the attempt completes; anywhere else it aborts, deleting what
 * WorkOS stored, since someone may have sent the WorkOS link to a victim to
 * attach the victim's GitHub to the sender's account.
 * `/api/github/disconnect` forgets the connection here and in WorkOS.
 *
 * Clients open `connect` in a browser (Settings › Source Control).
 */

const GITHUB_CONNECT_PATH = "/api/github/connect";
const GITHUB_CALLBACK_PATH = "/api/github/callback";
const GITHUB_DISCONNECT_PATH = "/api/github/disconnect";

/** Where the browser lands once connected: the web app's Source Control settings. */
const SETTINGS_PATH = "/settings/source-control";

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
  "This Signalbox Cloud can't connect GitHub: it needs WorkOS Pipes with GitHub enabled.",
);

const SIGN_IN_FIRST = page(
  401,
  "Sign in first",
  "Sign in to Signalbox Cloud in this browser, then connect GitHub again from Settings.",
);

const connectRoute = HttpRouter.add(
  "GET",
  GITHUB_CONNECT_PATH,
  Effect.gen(function* () {
    const session = yield* browserSession;
    if (Option.isNone(session)) return SIGN_IN_FIRST;
    const url = yield* requestUrl;
    const crypto = yield* Crypto.Crypto;
    const grantId = (yield* Effect.orDie(crypto.randomUUIDv4)).replaceAll("-", "");
    const state = yield* (yield* CloudTokens.CloudTokens).sign({
      _tag: "github-connect",
      u: session.value.userId,
      gid: grantId,
      exp: (yield* Clock.currentTimeMillis) + GRANT_TTL_MS,
    });
    const returnTo = new URL(GITHUB_CALLBACK_PATH, url.origin);
    returnTo.searchParams.set("state", state);
    const started = yield* (yield* UserDirectory.UserDirectory)
      .forUser(session.value.userId)
      .beginGitHubConnect({ grantId, returnTo: returnTo.toString() });
    if (started._tag === "unavailable") return NOT_CONFIGURED;
    return HttpServerResponse.redirect(started.url, { headers: NO_STORE_HEADERS });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("github connect failed", { cause }).pipe(
        Effect.as(page(500, "Something went wrong", "Connecting GitHub failed. Try again.")),
      ),
    ),
  ),
);

const backToSettings = HttpServerResponse.redirect(SETTINGS_PATH, { headers: NO_STORE_HEADERS });

const callbackRoute = HttpRouter.add(
  "GET",
  GITHUB_CALLBACK_PATH,
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const tokens = yield* CloudTokens.CloudTokens;
    const attempt = yield* tokens
      .verify("github-connect", url.searchParams.get("state") ?? "")
      .pipe(Effect.option);
    // A stale or foreign link changes nothing; it just goes back to the settings.
    if (Option.isNone(attempt)) return backToSettings;
    const owner = attempt.value.u;
    const grantId = attempt.value.gid;
    const users = yield* UserDirectory.UserDirectory;
    const session = yield* browserSession;
    if (Option.isNone(session) || session.value.userId !== owner) {
      yield* users.forUser(owner).abortGitHubConnect(grantId);
      return page(
        400,
        "Start again from Signalbox",
        "This GitHub connection came back to a different Signalbox sign-in, so it was thrown away. Connect GitHub again from Settings.",
      );
    }
    // Backing out on GitHub's page lands here too, with nothing connected.
    if (url.searchParams.has("error")) return backToSettings;
    const result = yield* users.forUser(owner).completeGitHubConnect(grantId);
    if (result._tag === "failed") return page(400, "GitHub didn't connect", result.reason);
    return backToSettings;
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

export const layer = Layer.mergeAll(connectRoute, callbackRoute, disconnectRoute);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import {
  GITHUB_CONNECT_PATH,
  GitHubNativeConnectRequest,
  isGitHubNativeReturnUrl,
} from "@t3tools/contracts/signalboxGitHubConnect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudTokens from "../auth/CloudTokens.ts";
import {
  browserSession,
  NO_STORE_HEADERS,
  requestCredentials,
  requestUrl,
} from "../http/credentials.ts";
import { guarded, pageUser } from "../http/pageRoutes.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { GRANT_TTL_MS } from "./GitHubConnection.ts";
import * as GitHubNativeConnect from "./GitHubNativeConnect.ts";

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

const FAILED = page(500, "Something went wrong", "Connecting GitHub failed. Try again.");

const nativeConnectRoute = HttpRouter.add(
  "POST",
  GITHUB_CONNECT_PATH,
  guarded(
    "github native connect",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { bearer } = requestCredentials(request);
      if (!bearer) return HttpServerResponse.empty({ status: 401, headers: NO_STORE_HEADERS });
      const body = yield* HttpServerRequest.schemaBodyJson(GitHubNativeConnectRequest);
      const url = yield* requestUrl;
      const started = yield* GitHubNativeConnect.start({
        bearer,
        returnUrl: body.returnUrl,
        origin: url.origin,
      });
      return HttpServerResponse.jsonUnsafe(started ?? { error: "invalid_return_url" }, {
        status: started === null ? 400 : 200,
        headers: NO_STORE_HEADERS,
      });
    }).pipe(
      Effect.catchTags({
        CloudCredentialError: () =>
          Effect.succeed(HttpServerResponse.empty({ status: 401, headers: NO_STORE_HEADERS })),
        SchemaError: () =>
          Effect.succeed(HttpServerResponse.empty({ status: 400, headers: NO_STORE_HEADERS })),
        HttpServerError: () =>
          Effect.succeed(HttpServerResponse.empty({ status: 400, headers: NO_STORE_HEADERS })),
      }),
    ),
    FAILED,
  ),
);

const connectRoute = HttpRouter.add(
  "GET",
  GITHUB_CONNECT_PATH,
  guarded(
    "github connect",
    Effect.gen(function* () {
      const url = yield* requestUrl;
      const tokens = yield* CloudTokens.CloudTokens;
      const nativeState = url.searchParams.get("state");
      const native =
        nativeState === null
          ? null
          : yield* tokens
              .verify("github-native-start", nativeState)
              .pipe(Effect.orElseSucceed(() => null));
      if (nativeState !== null && (native === null || !isGitHubNativeReturnUrl(native.returnUrl))) {
        return page(
          400,
          "Start again from Signalbox",
          "This GitHub connection expired. Start it again in the app.",
        );
      }
      const session = yield* browserSession;
      if (native !== null && (Option.isNone(session) || session.value.userId !== native.u)) {
        // The existing browser sign-in binds its own callback cookie. A native bearer link alone proves nothing about this browser.
        const query = new URLSearchParams({
          returnTo: `${url.pathname}${url.search}`,
          selectAccount: "1",
        });
        return HttpServerResponse.redirect(`/sign-in?${query}`, { headers: NO_STORE_HEADERS });
      }
      if (Option.isNone(session)) return SIGN_IN_FIRST;
      const crypto = yield* Crypto.Crypto;
      const grantId =
        native?.gid ?? (yield* Effect.orDie(crypto.randomUUIDv4())).replaceAll("-", "");
      const state = yield* tokens.sign({
        _tag: "github-connect",
        u: session.value.userId,
        gid: grantId,
        exp: (yield* Clock.currentTimeMillis) + GRANT_TTL_MS,
        ...(native ? { returnUrl: native.returnUrl } : {}),
      });
      const returnTo = new URL(GITHUB_CALLBACK_PATH, url.origin);
      returnTo.searchParams.set("state", state);
      const started = yield* (yield* UserDirectory.UserDirectory)
        .forUser(session.value.userId)
        .beginGitHubConnect({ grantId, returnTo: returnTo.toString() });
      if (started._tag === "unavailable") return NOT_CONFIGURED;
      if (started._tag === "expired")
        return page(
          400,
          "Start again from Signalbox",
          "This GitHub connection was already started. Start it again in the app.",
        );
      return HttpServerResponse.redirect(started.url, { headers: NO_STORE_HEADERS });
    }),
    FAILED,
  ),
);

const backToSettings = HttpServerResponse.redirect(SETTINGS_PATH, { headers: NO_STORE_HEADERS });

const callbackRoute = HttpRouter.add(
  "GET",
  GITHUB_CALLBACK_PATH,
  guarded(
    "github callback",
    Effect.gen(function* () {
      const url = yield* requestUrl;
      const tokens = yield* CloudTokens.CloudTokens;
      const attempt = yield* tokens
        .verify("github-connect", url.searchParams.get("state") ?? "")
        .pipe(Effect.option);
      // A stale or foreign link changes nothing; it just goes back to the settings.
      if (Option.isNone(attempt)) return backToSettings;
      const returnUrl = attempt.value.returnUrl;
      if (returnUrl !== undefined && !isGitHubNativeReturnUrl(returnUrl)) return backToSettings;
      const back = (result: "connected" | "cancelled" | "failed") =>
        returnUrl === undefined
          ? backToSettings
          : HttpServerResponse.redirect(GitHubNativeConnect.returnLocation(returnUrl, result), {
              headers: NO_STORE_HEADERS,
            });
      const owner = attempt.value.u;
      const grantId = attempt.value.gid;
      const users = yield* UserDirectory.UserDirectory;
      const session = yield* browserSession;
      if (Option.isNone(session) || session.value.userId !== owner) {
        yield* users.forUser(owner).abortGitHubConnect(grantId);
        if (returnUrl !== undefined) return back("failed");
        return page(
          400,
          "Start again from Signalbox",
          "This GitHub connection came back to a different Signalbox sign-in, so it was thrown away. Connect GitHub again from Settings.",
        );
      }
      // Backing out on GitHub's page lands here too, with nothing connected.
      if (url.searchParams.has("error")) {
        const cancelled = yield* users.forUser(owner).cancelGitHubConnect(grantId);
        return back(cancelled ? "cancelled" : "failed");
      }
      const result = yield* users.forUser(owner).completeGitHubConnect(grantId);
      if (result._tag === "failed")
        return returnUrl === undefined
          ? page(400, "GitHub didn't connect", result.reason)
          : back("failed");
      return back("connected");
    }),
    FAILED,
  ),
);

const disconnectRoute = HttpRouter.add(
  "POST",
  GITHUB_DISCONNECT_PATH,
  guarded(
    "github disconnect",
    Effect.gen(function* () {
      const user = yield* pageUser;
      if (user._tag === "cross_site") {
        return HttpServerResponse.text("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
      }
      if (user._tag === "signed_out") {
        return HttpServerResponse.text("Unauthorized", { status: 401, headers: NO_STORE_HEADERS });
      }
      yield* (yield* UserDirectory.UserDirectory).forUser(user.userId).disconnectGitHub();
      return HttpServerResponse.empty({ status: 204, headers: NO_STORE_HEADERS });
    }),
    HttpServerResponse.text("Internal Server Error", { status: 500, headers: NO_STORE_HEADERS }),
  ),
);

export const layer = Layer.mergeAll(
  nativeConnectRoute,
  connectRoute,
  callbackRoute,
  disconnectRoute,
);

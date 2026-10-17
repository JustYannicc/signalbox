import { describe, expect, it } from "@effect/vitest";
import { workosStubLayer } from "@signalbox/account/WorkOSTesting";
import { startGitHubNativeConnect } from "@t3tools/client-runtime/account";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as TestClock from "effect/testing/TestClock";

import * as CloudAccounts from "../account/CloudAccounts.ts";
import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as AccountRoutes from "../http/accountRoutes.ts";
import * as Platform from "../platform.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as GitHubRoutes from "./githubRoutes.ts";
import { makeFakeGitHub } from "./githubTesting.ts";

const ORIGIN = "https://cloud.example.com";
const RETURN_URL = "signalbox://account-return";
const OWNER = "user_native";
const OTHER = "user_browser";
const cookie = (token: string) => ({ cookie: `signalbox_cloud_session=${token}` });
const location = (response: Response) => response.headers.get("location") ?? "";

const setup = Effect.gen(function* () {
  // These cases only use Pipes and /user; the fake's git operations are never reached.
  const github = makeFakeGitHub({
    bare: "/unused",
    repository: "owner/repo",
    defaultBranch: "main",
  });
  const cloud = makeMemoryCloud({ github: github.layer });
  const context = yield* Layer.build(
    CloudAccounts.layer.pipe(
      Layer.provideMerge(CloudSessions.layer),
      Layer.provideMerge(CloudTokens.layer),
      Layer.provideMerge(layerConfig()),
      Layer.provideMerge(Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory)),
      Layer.provideMerge(workosStubLayer({ native: { id: OWNER, email: "native@example.com" } })),
      Layer.provideMerge(Platform.layerCrypto),
    ),
  );
  const sessions = Context.get(context, CloudSessions.CloudSessions);
  const tokens = Context.get(context, CloudTokens.CloudTokens);
  const owner = cloud.userDirectory.forUser(OWNER);
  yield* owner.recordSignIn({ id: OWNER, email: "native@example.com" });
  const native = yield* sessions.create({ userId: OWNER, method: "bearer-access-token" });
  const browser = yield* sessions.create({ userId: OWNER, method: "browser-session-cookie" });
  const other = yield* sessions.create({ userId: OTHER, method: "browser-session-cookie" });
  const httpEffect = yield* HttpRouter.toHttpEffect(
    Layer.mergeAll(GitHubRoutes.layer, AccountRoutes.layer),
  );
  const handler = HttpEffect.toWebHandler(
    httpEffect.pipe(Effect.provide(Context.merge(yield* Effect.context<never>(), context))),
  );
  const request = (path: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(new URL(path, ORIGIN), init)));
  const start = (returnUrl = RETURN_URL, bearer = native.token, browserToken?: string) =>
    request("/api/github/connect", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...(browserToken ? cookie(browserToken) : {}),
      },
      body: JSON.stringify({ returnUrl }),
    });
  const startUrl = Effect.promise(() =>
    startGitHubNativeConnect(ORIGIN, native.token, RETURN_URL, {
      fetch: (input, init) => handler(new Request(input, init)),
    }),
  );
  const begin = Effect.gen(function* () {
    const url = yield* startUrl;
    expect((yield* request(url, { headers: cookie(browser.token) })).status).toBe(302);
    const callback = github.authorize(OWNER);
    expect(callback).not.toBeNull();
    return { url, callback: callback! };
  });
  return {
    request,
    start,
    startUrl,
    begin,
    sessions,
    tokens,
    owner,
    github,
    native,
    browser,
    other,
  };
});

describe("native GitHub connect", () => {
  it.effect(
    "starts from the native identity without a cookie, signs the browser in, then returns to the app",
    () =>
      Effect.gen(function* () {
        const { startUrl, request, native, github, owner } = yield* setup;
        const url = yield* startUrl;
        expect(url).not.toContain(native.token);
        const signin = yield* request(url);
        expect(signin.status).toBe(302);
        const signinUrl = new URL(location(signin), ORIGIN);
        expect(signinUrl.pathname).toBe("/sign-in");
        expect(signinUrl.searchParams.get("returnTo")).toBe(
          new URL(url).pathname + new URL(url).search,
        );
        expect(github.calls).toHaveLength(0);

        const authorize = new URL("/api/account/authorize", ORIGIN);
        authorize.search = new URLSearchParams({
          provider: "email",
          mode: "browser",
          origin: ORIGIN,
          returnTo: signinUrl.searchParams.get("returnTo")!,
        }).toString();
        const authorized = yield* request(authorize.toString());
        const bindingCookie = authorized.headers.get("set-cookie")!.split(";")[0]!;
        const callback = new URL("/api/account/callback", ORIGIN);
        callback.search = new URLSearchParams({
          state: new URL(location(authorized)).searchParams.get("state")!,
          code: "native",
        }).toString();
        const signedIn = yield* request(callback.toString(), {
          headers: { cookie: bindingCookie },
        });
        const sessionCookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
        expect(location(signedIn)).toBe(new URL(url).pathname + new URL(url).search);
        const begun = yield* request(location(signedIn), { headers: { cookie: sessionCookie } });
        expect(location(begun)).toContain("authorize-redirect");
        const githubCallback = github.authorize(OWNER)!;
        const completed = yield* request(githubCallback, { headers: { cookie: sessionCookie } });
        expect(location(completed)).toBe(`${RETURN_URL}?github=connected`);
        expect(yield* owner.githubAccessToken()).toBe(`gho_${OWNER}`);
      }),
  );

  it.effect("never lets a different browser account override the native identity", () =>
    Effect.gen(function* () {
      const { start, request, tokens, other, github } = yield* setup;
      const response = yield* start(RETURN_URL, undefined, other.token);
      const body = yield* Effect.promise(() => response.json() as Promise<{ url: string }>);
      const claims = yield* tokens.verify(
        "github-native-start",
        new URL(body.url).searchParams.get("state")!,
      );
      expect(claims.u).toBe(OWNER);
      const signin = yield* request(body.url, { headers: cookie(other.token) });
      expect(new URL(location(signin), ORIGIN).pathname).toBe("/sign-in");
      expect(github.calls).toHaveLength(0);
    }),
  );

  it.effect.each(["missing", "different"] as const)(
    "aborts a callback with %s browser identity, even with the native bearer",
    (identity) =>
      Effect.gen(function* () {
        const { begin, request, native, other, owner, github } = yield* setup;
        const { callback, url } = yield* begin;
        const result = yield* request(callback, {
          headers: {
            authorization: `Bearer ${native.token}`,
            ...(identity === "different" ? cookie(other.token) : {}),
          },
        });
        expect(location(result)).toBe(`${RETURN_URL}?github=failed`);
        expect(github.isConnected(OWNER)).toBe(false);
        expect(yield* owner.githubAccessToken()).toBeNull();
        expect((yield* request(url, { headers: cookie(native.token) })).status).toBe(400);
      }),
  );

  it.effect("consumes native starts once and rejects replayed callbacks", () =>
    Effect.gen(function* () {
      const { begin, request, browser, github } = yield* setup;
      const { url, callback } = yield* begin;
      expect((yield* request(url, { headers: cookie(browser.token) })).status).toBe(400);
      expect(github.calls.filter((call) => call.endsWith("/authorize"))).toHaveLength(1);
      expect(location(yield* request(callback, { headers: cookie(browser.token) }))).toBe(
        `${RETURN_URL}?github=connected`,
      );
      expect(location(yield* request(callback, { headers: cookie(browser.token) }))).toBe(
        `${RETURN_URL}?github=failed`,
      );
    }),
  );

  it.effect("returns cancellation to native and prevents restarting the cancelled state", () =>
    Effect.gen(function* () {
      const { begin, request, browser, github } = yield* setup;
      const { url, callback } = yield* begin;
      const result = yield* request(`${callback}&error=access_denied`, {
        headers: cookie(browser.token),
      });
      expect(location(result)).toBe(`${RETURN_URL}?github=cancelled`);
      expect(github.isConnected(OWNER)).toBe(false);
      expect((yield* request(url, { headers: cookie(browser.token) })).status).toBe(400);
      expect(location(yield* request(callback, { headers: cookie(browser.token) }))).toBe(
        `${RETURN_URL}?github=failed`,
      );
    }),
  );

  it.effect("rejects expired and tampered start state before contacting Pipes", () =>
    Effect.gen(function* () {
      const { startUrl, request, browser, github } = yield* setup;
      const url = yield* startUrl;
      yield* TestClock.adjust("11 minutes");
      expect((yield* request(url, { headers: cookie(browser.token) })).status).toBe(400);
      expect((yield* request(`${url}tampered`, { headers: cookie(browser.token) })).status).toBe(
        400,
      );
      expect(github.calls).toHaveLength(0);
    }),
  );

  it.effect("rejects expired callbacks without completing a connection", () =>
    Effect.gen(function* () {
      const { begin, request, browser, owner } = yield* setup;
      const { callback } = yield* begin;
      yield* TestClock.adjust("11 minutes");
      expect(location(yield* request(callback, { headers: cookie(browser.token) }))).toBe(
        "/settings/source-control",
      );
      expect(yield* owner.githubAccessToken()).toBeNull();
    }),
  );

  it.effect("requires a live bearer and accepts only app account-return targets", () =>
    Effect.gen(function* () {
      const { start, request, native, browser, sessions } = yield* setup;
      expect(
        (yield* request("/api/github/connect", {
          method: "POST",
          headers: cookie(browser.token),
          body: JSON.stringify({ returnUrl: RETURN_URL }),
        })).status,
      ).toBe(401);
      expect((yield* start(RETURN_URL, "invalid")).status).toBe(401);
      for (const target of [
        "https://evil.test",
        "javascript:alert(1)",
        "other://account-return",
        "signalbox://other",
        "signalbox://account-return?next=evil",
        "signalbox://account-return#secret",
      ]) {
        expect((yield* start(target)).status).toBe(400);
      }
      for (const target of [
        RETURN_URL,
        "signalbox-dev://account-return",
        "signalbox-preview://account-return",
      ])
        expect((yield* start(target)).status).toBe(200);
      yield* sessions.revoke({ bearer: native.token });
      expect((yield* start()).status).toBe(401);
    }),
  );

  it.effect("keeps the browser-only flow and callback ownership check", () =>
    Effect.gen(function* () {
      const { request, browser, other, github } = yield* setup;
      expect((yield* request("/api/github/connect")).status).toBe(401);
      yield* request("/api/github/connect", { headers: cookie(browser.token) });
      const callback = github.authorize(OWNER)!;
      expect((yield* request(callback, { headers: cookie(other.token) })).status).toBe(400);
      expect(github.isConnected(OWNER)).toBe(false);
    }),
  );
});

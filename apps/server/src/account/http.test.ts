import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";

import * as AccountHttp from "./http.ts";
import { WORKOS_TEST_ENV, workosStubLayer } from "@signalbox/account/WorkOSTesting";

import { environmentAuthLayer } from "./testing.ts";

const ORIGIN = "http://127.0.0.1:5733";

const dependencies = Layer.mergeAll(
  environmentAuthLayer,
  workosStubLayer({
    "code-owner": { id: "user_owner", email: "owner@example.com" },
    "code-github": {
      verify: { code: "123456", user: { id: "user_github", email: "gh@example.com" } },
    },
  }),
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { ...WORKOS_TEST_ENV, T3CODE_WORKOS_API_KEY: "sk_test" } }),
  ),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");

it.effect("browser sign-in, email verification and sign-out over HTTP", () =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      // The server provides these to handlers from its runtime; here the router
      // does. Built once so the service and the handlers share one database.
      const context = yield* Layer.build(dependencies);
      const services = Layer.succeedContext(context);
      const routesLayer = AccountHttp.layer.pipe(
        HttpRouter.provideRequest(services),
        Layer.provide(services),
      );
      return HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
    }),
    ({ handler }) =>
      Effect.gen(function* () {
        const get = (path: string, cookie?: string) =>
          handler(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
        const post = (path: string, cookie?: string, body?: unknown) =>
          handler(
            new Request(`${ORIGIN}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
              ...(body ? { body: encodeJson(body) } : {}),
            }),
          );

        yield* Effect.promise(async () => {
          const invalid = await get(
            `/api/account/authorize?provider=google&mode=browser&origin=${ORIGIN}&returnTo=//evil.com`,
          );
          expect(invalid.status).toBe(400);
          expect(invalid.headers.get("location")).toBeNull();

          const startSignIn = async (code = "code-owner") => {
            const authorize = await get(
              `/api/account/authorize?provider=google&mode=browser&origin=${encodeURIComponent(
                ORIGIN,
              )}&returnTo=%2Fthreads`,
            );
            expect(authorize.status).toBe(302);
            const workosUrl = new URL(authorize.headers.get("location") ?? "");
            expect(workosUrl.origin).toBe("https://workos.test");
            expect(workosUrl.searchParams.get("redirect_uri")).toBe(
              `${ORIGIN}/api/account/callback`,
            );
            return `/api/account/callback?code=${code}&state=${workosUrl.searchParams.get("state")}`;
          };

          const callback = await get(await startSignIn());
          expect(callback.status).toBe(302);
          expect(callback.headers.get("location")).toBe("/threads");
          const setCookie = callback.headers.getSetCookie();
          expect(setCookie).toHaveLength(1);
          expect(setCookie[0]).toMatch(/^t3_session_.*HttpOnly/);
          const cookie = cookieHeader(callback);

          const session = await get("/api/account/session", cookie);
          expect(session.status).toBe(200);
          expect(await session.json()).toMatchObject({
            enabled: true,
            account: { id: "user_owner", email: "owner@example.com" },
          });

          const signOut = await handler(
            new Request(`${ORIGIN}/api/account/sign-out`, { method: "POST", headers: { cookie } }),
          );
          expect(signOut.status).toBe(204);
          expect(signOut.headers.getSetCookie()[0]).toMatch(/^t3_session_[^=]*=;.*Max-Age=0/);

          const afterSignOut = await get("/api/account/session", cookie);
          expect(await afterSignOut.json()).toMatchObject({ enabled: true, account: null });

          const unauthenticated = await handler(
            new Request(`${ORIGIN}/api/account/sign-out`, { method: "POST" }),
          );
          expect(unauthenticated.status).toBe(401);

          const unknownHandoff = await post("/api/account/handoff", undefined, {
            handoff: "missing",
            verifier: "v",
          });
          expect(unknownHandoff.status).toBe(404);
          expect(await unknownHandoff.json()).toEqual({ error: "expired" });

          // Email verification (GitHub-style): the page posts the emailed code.
          const paused = await get(await startSignIn("code-github"));
          const verifyPage = new URL(paused.headers.get("location") ?? "");
          expect(`${verifyPage.origin}${verifyPage.pathname}`).toBe(`${ORIGIN}/sign-in`);
          expect(verifyPage.searchParams.get("email")).toBe("gh@example.com");
          const verifyId = verifyPage.searchParams.get("verify");
          expect(paused.headers.getSetCookie()).toHaveLength(0);

          const wrong = await post("/api/account/verify-email", undefined, {
            verify: verifyId,
            code: "000000",
          });
          expect(wrong.status).toBe(400);
          expect(await wrong.json()).toEqual({ error: "invalid-code" });

          const verified = await post("/api/account/verify-email", undefined, {
            verify: verifyId,
            code: "123456",
          });
          expect(verified.status).toBe(200);
          expect(await verified.json()).toEqual({ next: "/threads" });
          const verifiedSession = await get("/api/account/session", cookieHeader(verified));
          expect(await verifiedSession.json()).toMatchObject({
            account: { id: "user_github", email: "gh@example.com" },
          });

          const unknownVerify = await post("/api/account/verify-email", undefined, {
            verify: "missing",
            code: "123456",
          });
          expect(unknownVerify.status).toBe(404);
          expect(await unknownVerify.json()).toEqual({ error: "expired" });
        });
      }),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(Effect.scoped),
);

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { SESSION_COOKIE_NAME } from "../environment.ts";
import * as AccountRoutes from "../http/accountRoutes.ts";
import * as TestSignInRoutes from "../http/testSignInRoutes.ts";
import { CLOUD_TEST_ENV, layerAccounts } from "../testing.ts";
import * as TestIdentities from "./TestIdentities.ts";
import * as TestSignIn from "./TestSignIn.ts";
import * as TestSignInPolicy from "./TestSignInPolicy.ts";

const SECRET = "test-sign-in-secret-0123456789abcdefghijklmnop";
const readToken = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }));
const readMobile = Schema.decodeUnknownSync(Schema.Struct({ deepLink: Schema.String }));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "https://cloud.example.test";
const PREVIEW_ENV = {
  ...CLOUD_TEST_ENV,
  SIGNALBOX_STAGE: "pr-373",
  ENVIRONMENT_ID: "cloud-preview-373",
  E2E_SIGN_IN_SECRET: SECRET,
};
const USERS = {
  richard: { id: "user_test_richard", email: "richard@piedpiper.example", firstName: "Richard" },
  fresh: { id: "user_test_fresh", email: "casey@signalbox.example", firstName: "Casey" },
};

const setup = (env: Readonly<Record<string, string>> = PREVIEW_ENV) =>
  Effect.gen(function* () {
    const resolved: Array<string> = [];
    const identities = TestIdentities.TestIdentities.of({
      resolve: (name) => {
        resolved.push(name);
        const user = name === "richard" ? USERS.richard : USERS.fresh;
        return Effect.succeed({
          user,
          workos: { clientId: "client_test", apiBaseUrl: "https://api.workos.test" },
        });
      },
    });
    const context = yield* Layer.build(
      TestSignIn.layer.pipe(
        Layer.provideMerge(TestSignInPolicy.layer),
        Layer.provideMerge(Layer.succeed(TestIdentities.TestIdentities, identities)),
        Layer.provideMerge(layerAccounts({}, env)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    );
    const http = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(TestSignInRoutes.layer, AccountRoutes.layer),
    );
    const clock = yield* Clock.Clock;
    const handle = HttpEffect.toWebHandler(
      http.pipe(Effect.provide(context), Effect.provideService(Clock.Clock, clock)),
    );
    const post = (
      mode: "browser" | "token" | "mobile",
      user = "richard",
      signature?: string,
      transmittedBody?: (body: string) => Uint8Array<ArrayBuffer>,
    ) =>
      Effect.gen(function* () {
        const rawBody = encodeRequest({
          user,
          mode,
          environmentId: env.ENVIRONMENT_ID,
          expiresAt: (yield* Clock.currentTimeMillis) + 30_000,
        });
        const signed = yield* Effect.promise(async () => {
          const encoder = new TextEncoder();
          const key = await globalThis.crypto.subtle.importKey(
            "raw",
            encoder.encode(SECRET),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const digest = new Uint8Array(
            await globalThis.crypto.subtle.sign(
              "HMAC",
              key,
              encoder.encode(`POST\n/api/testing/sign-in\n${rawBody}`),
            ),
          );
          return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        });
        return yield* Effect.promise(() =>
          handle(
            new Request(`${ORIGIN}/api/testing/sign-in`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-signalbox-test-signature": signature ?? signed,
              },
              body: transmittedBody ? transmittedBody(rawBody) : rawBody,
            }),
          ),
        );
      });
    return { post, handle, resolved, sessions: Context.get(context, CloudSessions.CloudSessions) };
  });

describe("test sign-in through normal cloud sessions", () => {
  it.effect("rejects an unsigned BOM prepended to a signed HTTP body before identity lookup", () =>
    Effect.gen(function* () {
      const { post, resolved } = yield* setup();
      const response = yield* post("browser", "richard", undefined, (body) =>
        new TextEncoder().encode(`\uFEFF${body}`),
      );
      expect(response.status).toBe(401);
      expect(resolved).toEqual([]);
      expect(response.headers.get("set-cookie")).toBeNull();
    }),
  );

  it.effect("sets the normal browser cookie and account routes recognize the test person", () =>
    Effect.gen(function* () {
      const { post, handle } = yield* setup();
      const response = yield* post("browser");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie.toLowerCase()).toContain("httponly");
      expect(cookie.toLowerCase()).toContain("secure");
      expect(yield* Effect.promise(() => response.json())).not.toHaveProperty("token");
      const state = yield* Effect.promise(() =>
        handle(
          new Request(`${ORIGIN}/api/account/session`, {
            headers: { cookie: cookie.split(";")[0]! },
          }),
        ),
      );
      expect(yield* Effect.promise(() => state.json())).toMatchObject({ account: USERS.richard });
    }),
  );

  it.effect("issues a normal bearer session with standard scopes and revocation", () =>
    Effect.gen(function* () {
      const { post, sessions } = yield* setup();
      const response = yield* post("token", "fresh");
      expect(response.status).toBe(200);
      const { token } = readToken(yield* Effect.promise(() => response.json()));
      const session = yield* sessions.authenticate({ bearer: token });
      expect(session.userId).toBe(USERS.fresh.id);
      expect(session.method).toBe("bearer-access-token");
      expect(session.scopes).toEqual(CloudSessions.CLOUD_SESSION_SCOPES);
      yield* sessions.revoke({ bearer: token });
      expect((yield* sessions.authenticate({ bearer: token }).pipe(Effect.flip))._tag).toBe(
        "CloudCredentialError",
      );
    }),
  );

  it.effect("hands mobile a single-use code on the existing dev pairing route", () =>
    Effect.gen(function* () {
      const { post, sessions } = yield* setup();
      const response = yield* post("mobile");
      expect(response.status).toBe(200);
      const body = readMobile(yield* Effect.promise(() => response.json()));
      expect(body).not.toHaveProperty("token");
      const deepLink = new URL(body.deepLink);
      expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe(
        "signalbox-dev://connections/new",
      );
      expect(deepLink.searchParams.get("autoConnect")).toBe("1");
      const pairing = new URL(deepLink.searchParams.get("pairingUrl")!);
      expect(pairing.origin).toBe(ORIGIN);
      const credential = new URLSearchParams(pairing.hash.slice(1)).get("token")!;
      const exchange = () =>
        sessions.exchangeCredential(credential, {
          method: "bearer-access-token",
          scopes: CloudSessions.CLOUD_SESSION_SCOPES,
        });
      const { token } = yield* exchange();
      expect((yield* sessions.authenticate({ bearer: token })).userId).toBe(USERS.richard.id);
      expect((yield* exchange().pipe(Effect.flip))._tag).toBe("CloudCredentialError");
    }),
  );

  it.effect("rejects production even with valid test configuration and signature", () =>
    Effect.gen(function* () {
      const { post, resolved } = yield* setup({ ...PREVIEW_ENV, SIGNALBOX_STAGE: "production" });
      const response = yield* post("browser");
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(resolved).toEqual([]);
    }),
  );

  it.effect("rejects forged requests before looking up any test identity", () =>
    Effect.gen(function* () {
      const { post, resolved } = yield* setup();
      const response = yield* post("browser", "richard", "0".repeat(64));
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(resolved).toEqual([]);
    }),
  );

  it.effect(
    "rejects oversized bodies with and without a declared length before identity lookup",
    () =>
      Effect.gen(function* () {
        const { handle, resolved } = yield* setup();
        for (const headers of [{}, { "content-length": "8193" }]) {
          const response = yield* Effect.promise(() =>
            handle(
              new Request(`${ORIGIN}/api/testing/sign-in`, {
                method: "POST",
                headers,
                body: "x".repeat(8193),
              }),
            ),
          );
          expect(response.status).toBe(400);
        }
        expect(resolved).toEqual([]);
      }),
  );

  it.effect("returns production's 404 before attempting to read the body", () =>
    Effect.gen(function* () {
      const { handle } = yield* setup({ ...PREVIEW_ENV, SIGNALBOX_STAGE: "production" });
      const request = new Request(`${ORIGIN}/api/testing/sign-in`, { method: "POST", body: "bad" });
      yield* Effect.promise(() => request.text());
      expect((yield* Effect.promise(() => handle(request))).status).toBe(404);
    }),
  );
});

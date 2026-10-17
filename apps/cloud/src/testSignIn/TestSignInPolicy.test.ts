import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as TestSignInPolicy from "./TestSignInPolicy.ts";

const SECRET = "test-e2e-sign-in-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;
const MAX_BODY_BYTES = 8_192;
const encoder = new TextEncoder();

const previewEnv: Readonly<Record<string, string>> = {
  SIGNALBOX_STAGE: "pr-73",
  ENVIRONMENT_ID: "cloud-preview-73",
  E2E_SIGN_IN_SECRET: SECRET,
};

const makeLayer = (env: Readonly<Record<string, string>>) =>
  Layer.fresh(TestSignInPolicy.layer).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.orDie,
  );

const verifyWith = (env: Readonly<Record<string, string>>, rawBody: string, signature?: string) =>
  TestSignInPolicy.TestSignInPolicy.use((policy) => policy.verify(rawBody, signature)).pipe(
    Effect.provide(makeLayer(env)),
  );

const signed = async (rawBody: string) => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = encoder.encode(`POST\n/api/testing/sign-in\n${rawBody}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, message));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const rawRequest = (overrides: Record<string, unknown> = {}, environmentId = "cloud-preview-73") =>
  JSON.stringify({
    user: "richard",
    mode: "browser",
    environmentId,
    expiresAt: NOW + 30_000,
    ...overrides,
  });

const expectDenied = (
  effect: Effect.Effect<TestSignInPolicy.TestSignInRequest, TestSignInPolicy.TestSignInDeniedError>,
  reason: TestSignInPolicy.TestSignInDeniedError["reason"],
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    expect(error.reason).toBe(reason);
  });

describe("TestSignInPolicy", () => {
  it.effect("accepts the exact signed body at the byte limit and the maximum expiry window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const unpadded = rawRequest({ expiresAt: NOW + 60_000 });
      const rawBody = `${" ".repeat(MAX_BODY_BYTES - encoder.encode(unpadded).byteLength)}${unpadded}`;
      const signature = yield* Effect.promise(() => signed(rawBody));

      expect(encoder.encode(rawBody).byteLength).toBe(MAX_BODY_BYTES);
      expect(yield* verifyWith(previewEnv, rawBody, signature)).toEqual({
        user: "richard",
        mode: "browser",
        environmentId: "cloud-preview-73",
        expiresAt: NOW + 60_000,
      });
    }),
  );

  it.effect("rejects missing, forged, and tampered signatures", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const rawBody = rawRequest();
      const signature = yield* Effect.promise(() => signed(rawBody));

      yield* expectDenied(verifyWith(previewEnv, rawBody), "unauthorized");
      yield* expectDenied(verifyWith(previewEnv, rawBody, "0".repeat(64)), "unauthorized");
      yield* expectDenied(verifyWith(previewEnv, rawBody, "not-hex"), "unauthorized");

      const tamperedBodies = [
        rawBody.replace('"user":"richard"', '"user":"jared"'),
        rawBody.replace('"mode":"browser"', '"mode":"token"'),
        rawBody.replace("cloud-preview-73", "cloud-preview-74"),
      ];
      for (const tampered of tamperedBodies) {
        yield* expectDenied(verifyWith(previewEnv, tampered, signature), "unauthorized");
      }
    }),
  );

  it.effect("enforces expiry against TestClock, including the strict current-time boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const expired = rawRequest({ expiresAt: NOW });
      yield* expectDenied(
        verifyWith(previewEnv, expired, yield* Effect.promise(() => signed(expired))),
        "invalid_request",
      );

      const tooFarAhead = rawRequest({ expiresAt: NOW + 60_001 });
      yield* expectDenied(
        verifyWith(previewEnv, tooFarAhead, yield* Effect.promise(() => signed(tooFarAhead))),
        "invalid_request",
      );

      const expiresSoon = rawRequest({ expiresAt: NOW + 1_000 });
      const signature = yield* Effect.promise(() => signed(expiresSoon));
      expect((yield* verifyWith(previewEnv, expiresSoon, signature)).expiresAt).toBe(NOW + 1_000);
      yield* TestClock.adjust(1_000);
      yield* expectDenied(verifyWith(previewEnv, expiresSoon, signature), "invalid_request");
    }),
  );

  it.effect("rejects malformed JSON, extra keys, invalid fields, and oversized UTF-8 bodies", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const malformedBodies = [
        "{",
        rawRequest().replace(/}$/, ',"unexpected":true}'),
        rawRequest({ expiresAt: "tomorrow" }),
        rawRequest({ user: "not-a-test-user" }),
        rawRequest({ mode: "desktop" }),
        "é".repeat(4_097),
      ];

      for (const rawBody of malformedBodies) {
        const signature = yield* Effect.promise(() => signed(rawBody));
        yield* expectDenied(verifyWith(previewEnv, rawBody, signature), "invalid_request");
      }
    }),
  );

  it.effect(
    "keeps production, unknown, and mismatched stages disabled despite a valid signature",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const rawBody = rawRequest();
        const signature = yield* Effect.promise(() => signed(rawBody));
        const disabledEnvironments = [
          { ...previewEnv, SIGNALBOX_STAGE: "prod", ENVIRONMENT_ID: "cloud-prod" },
          { ...previewEnv, SIGNALBOX_STAGE: "staging", ENVIRONMENT_ID: "cloud-preview-73" },
          { ...previewEnv, SIGNALBOX_STAGE: "pr-73", ENVIRONMENT_ID: "cloud-preview-74" },
          { ...previewEnv, SIGNALBOX_STAGE: "dev", ENVIRONMENT_ID: "cloud-dev" },
          {
            ...previewEnv,
            SIGNALBOX_STAGE: "dev",
            ENVIRONMENT_ID: "cloud-dev",
            LOCAL_WORKERD: "0",
          },
          {
            ...previewEnv,
            SIGNALBOX_STAGE: "dev",
            ENVIRONMENT_ID: "cloud-preview-73",
            LOCAL_WORKERD: "1",
          },
          { ...previewEnv, SIGNALBOX_STAGE: "pr-0", ENVIRONMENT_ID: "cloud-preview-0" },
          { ...previewEnv, E2E_SIGN_IN_SECRET: "short" },
          { SIGNALBOX_STAGE: "pr-73", ENVIRONMENT_ID: "cloud-preview-73" },
          {},
        ];

        for (const env of disabledEnvironments) {
          yield* expectDenied(verifyWith(env, rawBody, signature), "not_found");
        }

        const devRequest = rawRequest({}, "cloud-dev");
        const devSignature = yield* Effect.promise(() => signed(devRequest));
        const localDev = {
          SIGNALBOX_STAGE: "dev",
          ENVIRONMENT_ID: "cloud-dev",
          LOCAL_WORKERD: "1",
          E2E_SIGN_IN_SECRET: SECRET,
        };
        expect((yield* verifyWith(localDev, devRequest, devSignature)).environmentId).toBe(
          "cloud-dev",
        );
      }),
  );

  it.effect("accepts only the declared aliases and modes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const aliases = [
        "richard",
        "jared",
        "gilfoyle",
        "dinesh",
        "erlich",
        "gavin",
        "big-head",
        "fresh",
      ] as const;
      for (const user of aliases) {
        const rawBody = rawRequest({ user });
        const signature = yield* Effect.promise(() => signed(rawBody));
        expect((yield* verifyWith(previewEnv, rawBody, signature)).user).toBe(user);
      }

      for (const mode of ["browser", "token", "mobile"] as const) {
        const rawBody = rawRequest({ mode });
        const signature = yield* Effect.promise(() => signed(rawBody));
        expect((yield* verifyWith(previewEnv, rawBody, signature)).mode).toBe(mode);
      }

      const unknownAlias = rawRequest({ user: "someone-else" });
      yield* expectDenied(
        verifyWith(previewEnv, unknownAlias, yield* Effect.promise(() => signed(unknownAlias))),
        "invalid_request",
      );
    }),
  );
});

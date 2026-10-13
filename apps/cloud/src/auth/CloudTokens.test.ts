import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { CLOUD_TEST_ENV, layerConfig } from "../testing.ts";
import * as CloudTokens from "./CloudTokens.ts";

// Fresh, so a second secret in one test really builds a second instance.
const layerTokens = (secret: string = CLOUD_TEST_ENV.SESSION_SECRET) =>
  Layer.fresh(CloudTokens.layer).pipe(
    Layer.provide(layerConfig({ ...CLOUD_TEST_ENV, SESSION_SECRET: secret })),
  );

const MINUTE = 60_000;

const attempt = {
  codeVerifier: "verifier",
  origin: "https://cloud.example.com",
  target: { mode: "browser", returnTo: "/" },
} as const;

const reasonOf = <A>(effect: Effect.Effect<A, CloudTokens.CloudTokenInvalidError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("CloudTokens", () => {
  it.effect("verifies its own tokens until they expire", () =>
    Effect.gen(function* () {
      const tokens = yield* CloudTokens.CloudTokens;
      const token = yield* tokens.sign({
        _tag: "session",
        u: "user_1",
        sid: "s1",
        exp: 5 * MINUTE,
      });
      expect(yield* tokens.verify("session", token)).toEqual({
        _tag: "session",
        u: "user_1",
        sid: "s1",
        exp: 5 * MINUTE,
      });
      yield* TestClock.adjust("5 minutes");
      expect(yield* reasonOf(tokens.verify("session", token))).toBe("expired");
    }).pipe(Effect.provide(layerTokens())),
  );

  it.effect("rejects tampering, another kind, garbage and another secret", () =>
    Effect.gen(function* () {
      const tokens = yield* CloudTokens.CloudTokens;
      const token = yield* tokens.sign({ _tag: "ticket", u: "user_1", sid: "s1", exp: MINUTE });
      const other = yield* tokens.sign({ _tag: "ticket", u: "user_2", sid: "s1", exp: MINUTE });
      const [payload, signature] = token.split(".");
      // Another user's claims under this token's signature.
      const forged = `${other.split(".")[0]}.${signature}`;

      expect(yield* reasonOf(tokens.verify("ticket", forged))).toBe("signature");
      expect(yield* reasonOf(tokens.verify("session", token))).toBe("kind");
      expect(yield* reasonOf(tokens.verify("ticket", `${payload}`))).toBe("malformed");
      expect(yield* reasonOf(tokens.verify("ticket", "not.a.token"))).toBe("malformed");

      const elsewhere = yield* CloudTokens.CloudTokens.pipe(
        Effect.provide(layerTokens("another-secret-0123456789abcdefghijkl")),
      );
      expect(yield* reasonOf(elsewhere.verify("ticket", token))).toBe("signature");
    }).pipe(Effect.provide(layerTokens())),
  );

  it.effect("seals values that only open as the same kind", () =>
    Effect.gen(function* () {
      const tokens = yield* CloudTokens.CloudTokens;
      const sealed = yield* tokens.seal({ _tag: "attempt", attempt, exp: MINUTE });
      expect(yield* tokens.open("attempt", sealed)).toEqual({
        _tag: "attempt",
        attempt,
        exp: MINUTE,
      });
      // The kind is associated data: an attempt never opens as a paused verification.
      expect(yield* reasonOf(tokens.open("verification", sealed))).toBe("signature");
      const [iv, ciphertext] = sealed.split(".");
      const flipped = `${iv}.${ciphertext?.startsWith("A") ? "B" : "A"}${ciphertext?.slice(1)}`;
      expect(yield* reasonOf(tokens.open("attempt", flipped))).toBe("signature");
    }).pipe(Effect.provide(layerTokens())),
  );

  it.effect("opens an expired seal, so callers can still say where it was going", () =>
    Effect.gen(function* () {
      const tokens = yield* CloudTokens.CloudTokens;
      const sealed = yield* tokens.seal({ _tag: "attempt", attempt, exp: MINUTE });
      yield* TestClock.adjust("1 hour");
      expect((yield* tokens.open("attempt", sealed)).attempt).toEqual(attempt);
    }).pipe(Effect.provide(layerTokens())),
  );
});

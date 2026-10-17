import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as IdentityProvider from "./IdentityProvider.ts";

const primary = {
  clientId: "client_primary",
  apiKey: Redacted.make("sk_live_primary"),
  apiBaseUrl: "https://api.workos.com",
} as const;
const e2e = {
  clientId: "client_e2e",
  apiKey: Redacted.make("sk_test_e2e"),
  apiBaseUrl: "https://api.workos.com",
} as const;

const hash = (userId: string) =>
  Effect.promise(async () => {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId)),
    );
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

describe("IdentityProviders", () => {
  it.effect("routes only registered user hashes to the enabled E2E provider", () =>
    Effect.gen(function* () {
      const registeredUser = "synthetic-test-user";
      const registeredHash = yield* hash(registeredUser);
      const resolver = IdentityProvider.makeIdentityProviderResolver({
        primary,
        e2e,
        enabled: true,
        knownHashes: new Set([registeredHash]),
      });

      expect(yield* resolver.identityProviderForUser("ordinary-user")).toBe(primary);
      expect(yield* resolver.identityProviderForUser(registeredUser)).toBe(e2e);
    }),
  );

  it.effect("fails closed for a registered user when E2E identity is disabled", () =>
    Effect.gen(function* () {
      const registeredUser = "synthetic-test-user";
      const registeredHash = yield* hash(registeredUser);
      const resolver = IdentityProvider.makeIdentityProviderResolver({
        primary,
        e2e,
        enabled: false,
        knownHashes: new Set([registeredHash]),
      });

      expect((yield* resolver.identityProviderForUser(registeredUser).pipe(Effect.flip))._tag).toBe(
        "IdentityProviderUnavailable",
      );
    }),
  );

  it.effect("fails closed for a registered user with no E2E provider", () =>
    Effect.gen(function* () {
      const registeredUser = "synthetic-test-user";
      const registeredHash = yield* hash(registeredUser);
      const resolver = IdentityProvider.makeIdentityProviderResolver({
        primary,
        e2e: undefined,
        enabled: true,
        knownHashes: new Set([registeredHash]),
      });

      expect((yield* resolver.identityProviderForUser(registeredUser).pipe(Effect.flip))._tag).toBe(
        "IdentityProviderUnavailable",
      );
    }),
  );

  it.effect("fails closed when the enabled E2E provider reuses or lacks sandbox credentials", () =>
    Effect.gen(function* () {
      const registeredUser = "synthetic-test-user";
      const registeredHash = yield* hash(registeredUser);
      const invalidProviders = [
        { ...e2e, clientId: primary.clientId },
        { ...e2e, apiKey: primary.apiKey },
        { ...e2e, apiKey: Redacted.make("sk_live_e2e") },
        { clientId: e2e.clientId, apiBaseUrl: e2e.apiBaseUrl },
      ];

      for (const invalidProvider of invalidProviders) {
        const resolver = IdentityProvider.makeIdentityProviderResolver({
          primary,
          e2e: invalidProvider,
          enabled: true,
          knownHashes: new Set([registeredHash]),
        });
        expect(
          (yield* resolver.identityProviderForUser(registeredUser).pipe(Effect.flip))._tag,
        ).toBe("IdentityProviderUnavailable");
      }
    }),
  );
});

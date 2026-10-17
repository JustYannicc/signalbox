import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/boat-dev/Credentials";
import { ConfigError } from "@distilled.cloud/boat-dev/Errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "alchemy/Auth/Resolve";
import {
  BOAT_AUTH_PROVIDER_NAME,
  type BoatAuthConfig,
  type BoatResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/boat-dev/Credentials";

/**
 * Build Boat `Credentials` from an explicit API key. Useful for tests or
 * when the caller already has a key in hand.
 *
 * @example
 * ```ts
 * Effect.provide(Boat.fromApiKey({ apiKey: Redacted.make("...") }))
 * ```
 */
export const fromApiKey = (input: {
  apiKey: string | Redacted.Redacted<string>;
  apiBaseUrl?: string | undefined;
}) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey: typeof input.apiKey === "string" ? Redacted.make(input.apiKey) : input.apiKey,
      apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

/**
 * Build Boat `Credentials` that resolve through the Alchemy AuthProvider:
 * environment credentials (`BOAT_API_KEY`) when present, otherwise the
 * selected profile. Resolution is deferred until the first API call, so
 * building the provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = yield* resolveProviderConfig<BoatAuthConfig, BoatResolvedCredentials>(
        BOAT_AUTH_PROVIDER_NAME,
      ).pipe(
        Effect.flatMap(({ profileName, resolve }) =>
          Effect.mapError(resolve, (e) =>
            ConfigError.make({
              message: `Failed to resolve Boat credentials from ${profileName === undefined ? "the environment" : `profile '${profileName}'`}: ${e.message}`,
            }),
          ),
        ),
        deferUntilFirstUse,
      );
      const cached = yield* Effect.cached(
        resolve.pipe(orDieCredentialsUnavailable(BOAT_AUTH_PROVIDER_NAME)),
      );
      return Effect.map(cached, (creds) => ({
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
      }));
    }),
  );

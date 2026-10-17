import { DEFAULT_API_BASE_URL } from "@distilled.cloud/boat-dev/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Boat AuthProvider from inside provider Layers.
 */
export const BOAT_AUTH_PROVIDER_NAME = "Boat";

export type BoatAuthConfig = StoredAuthConfig;

/**
 * Resolved Boat Public API credentials.
 *
 * Boat authenticates with API keys only (`Authorization: Bearer <key>`).
 * Credential profiles and scoped API keys need an unrestricted account key
 * or one scoped with `account.admin`.
 */
export interface BoatResolvedCredentials {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: BoatAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("BOAT_API_KEY");
  if (apiKey === undefined || Redacted.value(apiKey).trim().length === 0) {
    return yield* AuthError.make({
      message: "Boat CI credentials not found. Set BOAT_API_KEY.",
    });
  }
  return {
    type: "apiKey" as const,
    apiKey: Redacted.make(Redacted.value(apiKey).trim()),
    apiBaseUrl:
      (yield* getEnv("BOAT_API_BASE_URL")) ??
      (yield* getEnv("BOAT_API_BASE")) ??
      DEFAULT_API_BASE_URL,
    source: { type: "env" as const, details: "BOAT_API_KEY" },
  } satisfies BoatResolvedCredentials;
});

const boatAuth = makeStoredAuthProvider<BoatResolvedCredentials>({
  provider: BOAT_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Boat API Key",
      description: "Create one in the Boat dashboard under API keys.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
  ],
  toResolved: (values, source) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "BOAT_API_KEY",
      required: true,
      secret: true,
      description: "Boat Public API key.",
    },
    {
      name: "BOAT_API_BASE_URL",
      required: false,
      alternatives: ["BOAT_API_BASE"],
      description: "Public API base URL override.",
    },
  ],
});

/**
 * Layer that registers the Boat AuthProvider into the AuthProviders
 * registry when built. Included in `Boat.providers()` so the alchemy CLI
 * (`alchemy profile edit`) can configure it.
 */
export const BoatAuth = boatAuth.layer;

/** Schema of Boat's inline API-key values. */
export const BoatStoredCredentials = boatAuth.storedSchema;
export type BoatStoredCredentials = typeof BoatStoredCredentials.Type;

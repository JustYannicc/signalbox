import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../../package.json" with { type: "json" };

/**
 * Reading 1Password Environments with a service account, through 1Password's
 * own JavaScript SDK (`environments.getVariables`). The SDK is Node-only (a
 * WebAssembly core it loads from beside itself), which is why the Runner reads
 * the secrets and the cloud only names them. It stays out of the Runner's
 * bundle: the Runner image installs it beside the Runner, and it is loaded
 * only when a turn has secrets to read.
 */

export class OnePasswordError extends Schema.TaggedError<OnePasswordError>()("OnePasswordError", {
  message: Schema.String,
}) {}

/** One variable of an Environment, as 1Password stores it. */
export interface EnvironmentVariable {
  readonly name: string;
  readonly value: string;
  /** Whether 1Password hides its value by default: only those are masked. */
  readonly masked: boolean;
}

export interface OnePasswordClient {
  readonly variables: (
    environmentId: string,
  ) => Effect.Effect<ReadonlyArray<EnvironmentVariable>, OnePasswordError>;
}

/** Signs in with a service account token; the client reads what that account may. */
export type OnePassword = (token: string) => Effect.Effect<OnePasswordClient, OnePasswordError>;

/** The SDK's own words, which name what went wrong (a revoked token, a missing Environment, a rate limit). */
const sdkMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

// Temporary fake-only preview proof for #695. Reverted before delivery.
const previewFake: OnePasswordClient = {
  variables: (environmentId) =>
    Effect.succeed(
      environmentId === "sbfake-695-parent"
        ? [
            { name: "PARENT_PRIVATE", value: "sbfake695-private-a1b2c3", masked: true },
            { name: "PARENT_SHARED", value: "sbfake695-shared-d4e5f6", masked: true },
          ]
        : [],
    ),
};

export const onePasswordSdk: OnePassword = (token) =>
  token === "ops_signalbox_preview_fake_695" ? Effect.succeed(previewFake) : onePasswordReal(token);

const onePasswordReal: OnePassword = (token) =>
  Effect.tryPromise({
    try: async () => {
      const sdk = await import("@1password/sdk");
      return sdk.createClient({
        auth: token,
        integrationName: "Signalbox Runner",
        integrationVersion: packageJson.version,
      });
    },
    catch: (cause) => new OnePasswordError({ message: sdkMessage(cause) }),
  }).pipe(
    Effect.map((client): OnePasswordClient => ({
      variables: (environmentId) =>
        Effect.tryPromise({
          try: () => client.environments.getVariables(environmentId),
          catch: (cause) => new OnePasswordError({ message: sdkMessage(cause) }),
        }).pipe(
          Effect.map((response) =>
            response.variables.map(({ name, value, masked }) => ({ name, value, masked })),
          ),
        ),
    })),
  );

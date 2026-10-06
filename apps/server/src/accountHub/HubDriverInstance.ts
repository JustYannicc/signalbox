/**
 * Claude, Grok, and Antigravity instances whose requests go through the
 * account hub, so every account added to the hub for that provider is pooled.
 *
 * Each harness runs unmodified, exactly like any other instance of its
 * driver, only pointed at the hub with the hub's client key. Accounts are
 * added with the hub's own sign-in, so their tokens never pass through
 * Signalbox's provider credential store.
 *
 * @module accountHub/HubDriverInstance
 */
import type {
  AntigravitySettings,
  ClaudeSettings,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import type { ProviderDriverCreateInput, ProviderInstance } from "../provider/ProviderDriver.ts";
import * as AccountHub from "./AccountHub.ts";
import type { AccountHubEndpoint, AccountHubOAuthProvider } from "./accountHubManagement.ts";
import { makeHubSignIn } from "./hubSignIn.ts";

type Variables = Readonly<Record<string, { readonly value: string; readonly sensitive?: boolean }>>;

/** The instance environment with the hub's variables set, replacing any the user set. */
export function withHubVariables(
  environment: ProviderInstanceEnvironment | undefined,
  variables: Variables,
): ProviderInstanceEnvironment {
  return [
    ...(environment ?? []).filter((variable) => !(variable.name in variables)),
    ...Object.entries(variables).map(([name, { value, sensitive }]) => ({
      name,
      value,
      sensitive: sensitive ?? false,
    })),
  ];
}

/** Claude Code reads Anthropic's base URL and bearer token from its environment. */
export const hubClaudeVariables = (hub: AccountHubEndpoint): Variables => ({
  ANTHROPIC_BASE_URL: { value: hub.baseUrl },
  ANTHROPIC_AUTH_TOKEN: { value: hub.clientKey, sensitive: true },
  // An inherited API key would win over the hub token.
  ANTHROPIC_API_KEY: { value: "" },
});

/**
 * Grok Build takes the hub as its xAI API and model catalog. The hub's catalog
 * lists every pooled model, so the default is pinned to a Grok model.
 */
export const hubGrokVariables = (hub: AccountHubEndpoint, home: string): Variables => ({
  XAI_API_KEY: { value: hub.clientKey, sensitive: true },
  GROK_MODELS_BASE_URL: { value: `${hub.baseUrl}/v1` },
  GROK_XAI_API_BASE_URL: { value: `${hub.baseUrl}/v1` },
  GROK_DEFAULT_MODEL: { value: "grok-4.7" },
  GROK_TELEMETRY_ENABLED: { value: "0" },
  GROK_HOME: { value: home },
});

/** Antigravity's Gemini API-key mode, aimed at the hub's Gemini endpoint. */
export const hubAntigravityVariables = (hub: AccountHubEndpoint): Variables => ({
  GOOGLE_GEMINI_BASE_URL: { value: hub.baseUrl },
});

const make = <C, E, R>(options: {
  readonly driver: ProviderDriverKind;
  readonly provider: AccountHubOAuthProvider;
  readonly input: ProviderDriverCreateInput<C>;
  readonly create: (input: ProviderDriverCreateInput<C>) => Effect.Effect<ProviderInstance, E, R>;
  readonly configure: (
    hub: AccountHubEndpoint,
  ) => Effect.Effect<
    { readonly config: C; readonly variables: Variables },
    never,
    Path.Path | ServerConfig.ServerConfig
  >;
}) =>
  Effect.gen(function* () {
    const hub = yield* AccountHub.AccountHub;
    const { instanceId } = options.input;
    // Harnesses read their base URL once, so take the hub's stable address now and
    // start the hub in the background: instance creation never waits on a download.
    const endpoint = yield* hub.plannedEndpoint.pipe(
      Effect.mapError(
        (error) =>
          new ProviderDriverError({ driver: options.driver, instanceId, detail: error.detail }),
      ),
    );
    if (options.input.enabled) {
      yield* hub.ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    }
    const { config, variables } = yield* options.configure(endpoint);
    const instance = yield* options.create({
      ...options.input,
      config,
      environment: withHubVariables(options.input.environment, variables),
    });
    const auth = yield* makeHubSignIn({ hub, instanceId, provider: options.provider });
    // Reset credits belong to a single login; the pool has no single account to redeem for.
    const { consumeResetCredit: _single, ...pooled } = instance;
    return { ...pooled, auth } satisfies ProviderInstance;
  });

export const makeHubClaudeInstance = <E, R>(
  driver: ProviderDriverKind,
  input: ProviderDriverCreateInput<ClaudeSettings>,
  create: (
    input: ProviderDriverCreateInput<ClaudeSettings>,
  ) => Effect.Effect<ProviderInstance, E, R>,
) =>
  make({
    driver,
    provider: "claude",
    input,
    create,
    configure: (hub) =>
      Effect.succeed({
        config: { ...input.config, setupMode: "existing" as const },
        variables: hubClaudeVariables(hub),
      }),
  });

export const makeHubGrokInstance = <E, R>(
  driver: ProviderDriverKind,
  input: ProviderDriverCreateInput<GrokSettings>,
  create: (input: ProviderDriverCreateInput<GrokSettings>) => Effect.Effect<ProviderInstance, E, R>,
) =>
  make({
    driver,
    provider: "xai",
    input,
    create,
    configure: (hub) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        // Its own home keeps the user's Grok login and config out of the pooled instance.
        const home = path.join(stateDir, "providers", "grok", input.instanceId);
        return {
          config: { ...input.config, setupMode: "existing" as const },
          variables: hubGrokVariables(hub, home),
        };
      }),
  });

export const makeHubAntigravityInstance = <E, R>(
  driver: ProviderDriverKind,
  input: ProviderDriverCreateInput<AntigravitySettings>,
  create: (
    input: ProviderDriverCreateInput<AntigravitySettings>,
  ) => Effect.Effect<ProviderInstance, E, R>,
) =>
  make({
    driver,
    provider: "antigravity",
    input,
    create,
    configure: (hub) =>
      Effect.succeed({
        config: {
          ...input.config,
          setupMode: "existing" as const,
          authMethod: "gemini-api-key" as const,
          apiKey: hub.clientKey,
        },
        variables: hubAntigravityVariables(hub),
      }),
  });

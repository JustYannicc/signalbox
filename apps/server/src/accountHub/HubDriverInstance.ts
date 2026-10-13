/**
 * Claude, Grok, Antigravity, Cursor, and OpenCode instances that run on an
 * account pool, so every account added to the pool for that provider is used.
 *
 * Each harness runs unmodified, exactly like any other instance of its
 * driver, only pointed at the hub with the hub's client key. Accounts are
 * added with the hub's own sign-in, so their tokens never pass through
 * Signalbox's provider credential store.
 *
 * @module accountHub/HubDriverInstance
 */
import {
  ProviderDriverKind,
  type AntigravitySettings,
  type ClaudeSettings,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import type { GrokSettings } from "@t3tools/provider-grok/settings";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import type {
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as AccountHub from "./AccountHub.ts";
import type { AccountHubEndpoint, AccountHubOAuthProvider } from "./accountHubManagement.ts";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import { CursorPoolCredentials } from "@t3tools/provider-cursor/server/poolCredentials";
import { makeCursorPool, makeCursorPoolSignIn } from "./hubCursor.ts";
import {
  OPENCODE_POOL_KEY_VARIABLE,
  configuredModels,
  hubModels,
  openCodeConfigPath,
  openCodeInstanceDirectory,
  renderOpenCodeConfig,
} from "./hubOpenCode.ts";
import { makeHubSignIn } from "./hubSignIn.ts";

type Variables = Readonly<Record<string, { readonly value: string; readonly sensitive?: boolean }>>;

/** The instance environment with the hub's variables set, replacing any the user set. */
function withHubVariables(
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
const hubClaudeVariables = (hub: AccountHubEndpoint): Variables => ({
  ANTHROPIC_BASE_URL: { value: hub.baseUrl },
  ANTHROPIC_AUTH_TOKEN: { value: hub.clientKey, sensitive: true },
  // An inherited API key would win over the hub token.
  ANTHROPIC_API_KEY: { value: "" },
});

/**
 * Grok Build takes the hub as its xAI API and model catalog. The hub's catalog
 * lists every pooled model, so the default is pinned to a Grok model.
 */
const hubGrokVariables = (hub: AccountHubEndpoint, home: string): Variables => ({
  XAI_API_KEY: { value: hub.clientKey, sensitive: true },
  GROK_MODELS_BASE_URL: { value: `${hub.baseUrl}/v1` },
  GROK_XAI_API_BASE_URL: { value: `${hub.baseUrl}/v1` },
  GROK_DEFAULT_MODEL: { value: "grok-4.7" },
  GROK_TELEMETRY_ENABLED: { value: "0" },
  GROK_HOME: { value: home },
});

/** Antigravity's Gemini API-key mode, aimed at the hub's Gemini endpoint. */
const hubAntigravityVariables = (hub: AccountHubEndpoint): Variables => ({
  GOOGLE_GEMINI_BASE_URL: { value: hub.baseUrl },
});

const DRIVER_OPENCODE = ProviderDriverKind.make("opencode");

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

/**
 * Cursor on a pool: the driver reads the pool's Cursor accounts instead of its
 * own sign-in, and a machine-wide `CURSOR_API_KEY` never reaches it.
 */
export const makeHubCursorInstance = <E, R>(
  input: ProviderDriverCreateInput<CursorSettings>,
  create: (
    input: ProviderDriverCreateInput<CursorSettings>,
  ) => Effect.Effect<ProviderInstance, E, R>,
) =>
  Effect.gen(function* () {
    const hub = yield* AccountHub.AccountHub;
    if (input.enabled) {
      yield* hub.ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    }
    const pool = yield* makeCursorPool(hub);
    const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
    const instance = yield* create({
      ...input,
      config: { ...input.config, setupMode: "existing" as const },
      environment: withHubVariables(input.environment, { CURSOR_API_KEY: { value: "" } }),
    }).pipe(
      Effect.provideService(CursorPoolCredentials, {
        store: pool.store,
        binding: { owner: "t3", key: `account-hub:${input.instanceId}` },
      }),
      // Each session takes the pool's next account, so sessions spread across it.
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        ...runner,
        open: (open) =>
          pool.next.pipe(
            Effect.flatMap((credential) =>
              runner.open(
                credential
                  ? { ...open, options: { ...open.options, apiKey: credential.apiKey } }
                  : open,
              ),
            ),
          ),
      }),
    );
    const auth = yield* makeCursorPoolSignIn({
      hub,
      instanceId: input.instanceId,
      displayName: input.displayName ?? "Cursor",
    });
    return { ...instance, auth } satisfies ProviderInstance;
  });

// Keys OpenCode would otherwise pick up from the server's environment.
const OPENCODE_BLANKED = [
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/**
 * OpenCode on a pool: its only provider is the pool's hub, and its config and
 * data live in a directory of its own. An external OpenCode server would skip
 * all of that, so a pool instance always runs its own.
 */
export const makeHubOpenCodeInstance = <E, R>(
  input: ProviderDriverCreateInput<OpenCodeSettings>,
  create: (
    input: ProviderDriverCreateInput<OpenCodeSettings>,
  ) => Effect.Effect<ProviderInstance, E, R>,
) =>
  Effect.gen(function* () {
    const hub = yield* AccountHub.AccountHub;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const { instanceId } = input;
    const endpoint = yield* hub.plannedEndpoint.pipe(
      Effect.mapError(
        (error) =>
          new ProviderDriverError({ driver: DRIVER_OPENCODE, instanceId, detail: error.detail }),
      ),
    );
    const directory = openCodeInstanceDirectory(path, stateDir, instanceId);
    const configPath = openCodeConfigPath(path, directory);
    // A running hub names its models now; otherwise the last list stands until it comes up.
    const running = yield* hub.endpoint;
    const served = Option.isSome(running)
      ? yield* hubModels(running.value).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.option,
        )
      : Option.none();
    const previous = yield* fs.readFileString(configPath).pipe(Effect.option);
    const contents = renderOpenCodeConfig({
      baseUrl: endpoint.baseUrl,
      name: input.displayName ?? "Pool",
      models: Option.isSome(served)
        ? served.value
        : Option.isSome(previous)
          ? configuredModels(previous.value)
          : [],
    });
    if (Option.getOrUndefined(previous) !== contents) {
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.andThen(writeFileStringAtomically({ filePath: configPath, contents })),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_OPENCODE,
              instanceId,
              detail: "Could not write the OpenCode pool configuration.",
              cause,
            }),
        ),
      );
    }
    if (input.enabled) {
      yield* hub.ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    }
    const variables: Variables = {
      XDG_CONFIG_HOME: { value: path.join(directory, "config") },
      XDG_DATA_HOME: { value: path.join(directory, "data") },
      XDG_STATE_HOME: { value: path.join(directory, "state") },
      XDG_CACHE_HOME: { value: path.join(directory, "cache") },
      OPENCODE_CONFIG: { value: configPath },
      // Replaces any inline config the server's environment carries.
      OPENCODE_CONFIG_CONTENT: { value: "{}" },
      [OPENCODE_POOL_KEY_VARIABLE]: { value: endpoint.clientKey, sensitive: true },
      ...Object.fromEntries(OPENCODE_BLANKED.map((name) => [name, { value: "" }])),
    };
    return yield* create({
      ...input,
      config: {
        ...input.config,
        setupMode: "existing" as const,
        serverUrl: "",
        serverPassword: "",
      },
      environment: withHubVariables(input.environment, variables),
    });
  });

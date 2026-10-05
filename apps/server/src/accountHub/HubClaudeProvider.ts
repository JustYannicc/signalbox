/**
 * A Claude instance whose requests go through the account hub, so every
 * Claude account added to it is pooled.
 *
 * Claude Code itself is unchanged: it runs exactly like any other Claude
 * instance, pointed at the hub with the hub's client key. Accounts are added
 * with the hub's own Claude sign-in, so their tokens never pass through
 * Signalbox's provider credential store.
 *
 * @module accountHub/HubClaudeProvider
 */
import {
  ProviderDriverKind,
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderDriverError } from "../provider/Errors.ts";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type { ProviderDriverCreateInput, ProviderInstance } from "../provider/ProviderDriver.ts";
import * as AccountHub from "./AccountHub.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");

/** The variables that send Claude Code to the hub instead of Anthropic. */
export function hubClaudeEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  endpoint: { readonly baseUrl: string; readonly clientKey: string },
): ProviderInstanceEnvironment {
  const owned = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  return [
    ...(environment ?? []).filter((variable) => !owned.has(variable.name)),
    { name: "ANTHROPIC_BASE_URL", value: endpoint.baseUrl, sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: endpoint.clientKey, sensitive: true },
    // An inherited API key would win over the hub token.
    { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
  ];
}

export const makeHubClaudeProvider = Effect.fn("makeHubClaudeProvider")(function* <E, R>(
  input: ProviderDriverCreateInput<ClaudeSettings>,
  createClaude: (
    input: ProviderDriverCreateInput<ClaudeSettings>,
  ) => Effect.Effect<ProviderInstance, E, R>,
) {
  const hub = yield* AccountHub.AccountHub;
  const { instanceId } = input;
  // Claude reads its base URL once, so take the hub's stable address now and start
  // the hub in the background: instance creation never waits on a download.
  const endpoint = yield* hub.plannedEndpoint.pipe(
    Effect.mapError(
      (error) => new ProviderDriverError({ driver: DRIVER, instanceId, detail: error.detail }),
    ),
  );
  if (input.enabled)
    yield* hub.ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  const instance = yield* createClaude({
    ...input,
    config: { ...input.config, setupMode: "existing" },
    environment: hubClaudeEnvironment(input.environment, endpoint),
  });

  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });
  const auth = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: `account-hub:${instanceId}` },
    methods: Effect.succeed([
      {
        id: "claude-add-account",
        name: "Add a Claude account",
        description: "Sign in with Claude. The account joins this pool.",
        type: "agent" as const,
      },
    ]),
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        // The hub can only catch the redirect itself when the browser runs on this machine.
        const login = yield* hub
          .startOAuthLogin("claude", { localCallback: context.callbackMode === "server" })
          .pipe(Effect.mapError((error) => setupError("start", error.detail)));
        yield* Effect.addFinalizer(() => login.cancel);
        yield* context.setInteraction(
          {
            type: "browser",
            id: context.flowId,
            url: login.url,
            requiresConsent: false,
            acceptsCallback: true,
          },
          undefined,
          (callbackUrl) =>
            login
              .complete(callbackUrl)
              .pipe(Effect.mapError((error) => setupError("complete", error.detail))),
        );
        yield* login.await.pipe(Effect.mapError((error) => setupError("save", error.detail)));
      }),
    logout: Effect.succeed("Accounts stay in the pool. Remove or pause them from Usage → Limits."),
  });

  // Reset credits belong to a single login; the pool has no single account to redeem for.
  const { consumeResetCredit: _single, ...pooled } = instance;
  return { ...pooled, auth } satisfies ProviderInstance;
});

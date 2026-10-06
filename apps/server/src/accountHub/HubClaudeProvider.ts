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
  type ClaudeSettings,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderDriverError } from "../provider/Errors.ts";
import type { ProviderDriverCreateInput, ProviderInstance } from "../provider/ProviderDriver.ts";
import * as AccountHub from "./AccountHub.ts";
import { makeHubSignIn } from "./hubSignIn.ts";

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

  const auth = yield* makeHubSignIn({ hub, instanceId, provider: "claude" });

  // Reset credits belong to a single login; the pool has no single account to redeem for.
  const { consumeResetCredit: _single, ...pooled } = instance;
  return { ...pooled, auth } satisfies ProviderInstance;
});

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

/**
 * The provider instances that run through the account hub. There is one per
 * provider; adding an account adds it to that instance's pool, so the model
 * picker never grows a row per account.
 */
export const HUB_INSTANCES = {
  codex: {
    instanceId: ProviderInstanceId.make("codex_hub"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex accounts",
    account: "ChatGPT",
  },
  claude: {
    instanceId: ProviderInstanceId.make("claude_hub"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude accounts",
    account: "Claude",
  },
  grok: {
    instanceId: ProviderInstanceId.make("grok_hub"),
    driver: ProviderDriverKind.make("grok"),
    displayName: "Grok accounts",
    account: "Grok",
  },
  antigravity: {
    instanceId: ProviderInstanceId.make("antigravity_hub"),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Antigravity accounts",
    account: "Antigravity",
  },
} as const;

export type HubAccountKind = keyof typeof HUB_INSTANCES;

export function isHubInstanceConfig(config: unknown): boolean {
  return (
    config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "hub"
  );
}

export function hubAccountKindForDriver(driver: ProviderDriverKind): HubAccountKind | null {
  return (
    (Object.keys(HUB_INSTANCES) as HubAccountKind[]).find(
      (kind) => HUB_INSTANCES[kind].driver === driver,
    ) ?? null
  );
}

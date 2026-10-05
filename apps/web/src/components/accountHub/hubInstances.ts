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
  if (driver === HUB_INSTANCES.codex.driver) return "codex";
  if (driver === HUB_INSTANCES.claude.driver) return "claude";
  return null;
}

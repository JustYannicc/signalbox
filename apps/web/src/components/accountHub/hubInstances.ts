import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID, poolInstanceId } from "@t3tools/contracts/accountHub";

/**
 * The kinds of accounts a pool holds. Each pool runs one provider instance per
 * kind; adding an account adds it to that instance's pool, so the model picker
 * never grows a row per account.
 */
export const HUB_INSTANCES = {
  codex: {
    driver: ProviderDriverKind.make("codex"),
    displayName: "ChatGPT",
    account: "ChatGPT",
  },
  claude: {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    account: "Claude",
  },
  grok: {
    driver: ProviderDriverKind.make("grok"),
    displayName: "Grok",
    account: "Grok",
  },
  antigravity: {
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Antigravity",
    account: "Antigravity",
  },
  cursor: {
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor",
    account: "Cursor",
  },
} as const;

export type HubAccountKind = keyof typeof HUB_INSTANCES;

/** The provider instance of `kind` in `poolId`. */
export const hubInstanceId = (kind: HubAccountKind, poolId: string = PERSONAL_POOL_ID) =>
  ProviderInstanceId.make(poolInstanceId(kind, poolId));

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

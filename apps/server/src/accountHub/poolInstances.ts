/**
 * The provider instances a pool runs: one per kind of account it holds, plus
 * OpenCode when the user turns it on. Adding the first account of a kind adds
 * that kind's instance, so the model picker never grows a row per account.
 *
 * @module accountHub/poolInstances
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID, poolInstanceId } from "@t3tools/contracts/accountHub";

export const POOL_INSTANCE_KINDS = {
  codex: { driver: "codex", displayName: "ChatGPT" },
  claude: { driver: "claudeAgent", displayName: "Claude" },
  grok: { driver: "grok", displayName: "Grok" },
  antigravity: { driver: "antigravity", displayName: "Antigravity" },
  cursor: { driver: "cursor", displayName: "Cursor" },
  opencode: { driver: "opencode", displayName: "OpenCode" },
} as const;

export type PoolInstanceKind = keyof typeof POOL_INSTANCE_KINDS;

/**
 * The instance of `kind` in a pool, ready to save. Outside the personal pool
 * it carries the pool's name, so the picker can tell pools apart.
 */
export function poolInstanceEntry(
  kind: PoolInstanceKind,
  pool: { readonly id: string; readonly name: string },
): readonly [ProviderInstanceId, ProviderInstanceConfig] {
  const { driver, displayName } = POOL_INSTANCE_KINDS[kind];
  return [
    ProviderInstanceId.make(poolInstanceId(kind, pool.id)),
    {
      driver: ProviderDriverKind.make(driver),
      displayName: pool.id === PERSONAL_POOL_ID ? displayName : `${displayName} · ${pool.name}`,
      enabled: true,
      config: {
        enabled: true,
        setupMode: "hub",
        ...(pool.id === PERSONAL_POOL_ID ? {} : { poolId: pool.id }),
      },
    },
  ];
}

/** `instances` with each kind's pool instance added where it is missing. */
export function withPoolInstances(
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
  pool: { readonly id: string; readonly name: string },
  kinds: Iterable<PoolInstanceKind>,
): Record<string, ProviderInstanceConfig> {
  const next: Record<string, ProviderInstanceConfig> = { ...instances };
  for (const kind of kinds) {
    const [id, entry] = poolInstanceEntry(kind, pool);
    if (!(id in next)) next[id] = entry;
  }
  return next;
}

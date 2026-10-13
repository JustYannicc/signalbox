import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { type AccountPool, hubInstancePoolId } from "@t3tools/contracts/accountHub";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useMemo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { usePoolViews } from "../../state/accountPools";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** One pool in the model picker: its name and the provider instances that run on it. */
export interface PickerPool {
  readonly id: string;
  readonly name: string;
  readonly instanceIds: ReadonlySet<ProviderInstanceId>;
}

const NOT_IN_A_POOL = "not-in-a-pool";

/**
 * The model picker's pools: every account pool with its providers, then the
 * providers no pool holds yet. Empty with one group, so the picker shows no
 * switcher until there is a choice to make. `providerInstances` is the
 * environment's setting, which says each instance's pool.
 */
export function pickerPools(
  accountPools: ReadonlyArray<Pick<AccountPool, "id" | "name">>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providerInstances: UnifiedSettings["providerInstances"],
): ReadonlyArray<PickerPool> {
  const byPool = new Map<string, Set<ProviderInstanceId>>();
  const outside = new Set<ProviderInstanceId>();
  const known = new Set<string>(accountPools.map((pool) => pool.id));
  for (const entry of entries) {
    const poolId = hubInstancePoolId(providerInstances[entry.instanceId]?.config);
    // A pool not listed yet (or gone) never hides its providers.
    if (poolId === null || !known.has(poolId)) {
      outside.add(entry.instanceId);
      continue;
    }
    byPool.set(poolId, (byPool.get(poolId) ?? new Set()).add(entry.instanceId));
  }
  const pools: PickerPool[] = accountPools
    .map((pool) => ({
      id: pool.id,
      name: pool.name,
      instanceIds: byPool.get(pool.id) ?? new Set<ProviderInstanceId>(),
    }))
    .filter((pool) => pool.instanceIds.size > 0);
  if (outside.size > 0) {
    pools.push({ id: NOT_IN_A_POOL, name: "Not in a pool", instanceIds: outside });
  }
  return pools.length > 1 ? pools : [];
}

/** {@link pickerPools} for an environment, kept live. */
export function usePickerPools(
  environmentId: EnvironmentId | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providerInstances: UnifiedSettings["providerInstances"],
): ReadonlyArray<PickerPool> {
  const accountPools = usePoolViews(environmentId);
  return useMemo(
    () => pickerPools(accountPools, entries, providerInstances),
    [accountPools, entries, providerInstances],
  );
}

/** The pool the picker opens on: the one running the current model, else the first. */
export function initialPickerPool(
  pools: ReadonlyArray<PickerPool>,
  activeInstanceId: ProviderInstanceId,
): string | null {
  return (pools.find((pool) => pool.instanceIds.has(activeInstanceId)) ?? pools[0])?.id ?? null;
}

/** Pick the pool first; the picker below then shows that pool's models. */
export function ModelPoolSwitcher({
  pools,
  selected,
  onSelect,
}: {
  readonly pools: ReadonlyArray<PickerPool>;
  readonly selected: string;
  readonly onSelect: (poolId: string) => void;
}) {
  return (
    <div className="border-b border-border/60 px-2 py-2">
      <ToggleGroup
        aria-label="Pool"
        variant="segmented"
        value={[selected]}
        onValueChange={(next) => {
          const value = next[0];
          if (value) onSelect(value);
        }}
      >
        {pools.map((pool) => (
          <Toggle key={pool.id} value={pool.id}>
            {pool.name}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

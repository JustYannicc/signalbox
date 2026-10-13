/**
 * Which pool a level's agent and threads route a harness through. Pools are
 * the reverse of most things: they reach every folder inside their level, and
 * the lowest level wins, so a project's own pool beats its section's, which
 * beats the top level's. Pass only the pools you can use (yours plus connected
 * shared ones); sharing with people decides that, not levels.
 */
import { nearestOnChain, type LevelKey } from "../levels/levels";
import type { AccountPool, PoolHarness } from "./accountPoolsModel";

type Placement = Parameters<typeof nearestOnChain>[2];

export interface PoolRoute {
  readonly harness: PoolHarness;
  /** Where the winning pools sit; null when none sits on the level's chain. */
  readonly from: LevelKey | null;
  /** Every usable pool for the harness at `from` (they're combined). */
  readonly pools: readonly AccountPool[];
  /** True when `from` is a level above the one asked about. */
  readonly inherited: boolean;
}

/** The levels a pool sits at: every level one of its accounts sits at. */
export function poolLevels(pool: AccountPool): readonly LevelKey[] {
  return [...new Set(pool.accounts.flatMap((account) => account.levels))];
}

/** The pools `level` routes `harness` through, and where they come from. */
export function routeFor(
  level: LevelKey,
  harness: PoolHarness,
  pools: readonly AccountPool[],
  placement?: Placement,
): PoolRoute {
  const candidates = pools.filter((pool) => pool.harness === harness);
  const from = nearestOnChain(level, candidates.flatMap(poolLevels), placement);
  return {
    harness,
    from,
    pools: from === null ? [] : candidates.filter((pool) => poolLevels(pool).includes(from)),
    inherited: from !== null && from !== level,
  };
}

/** One route per harness that has any usable pool, in the given harness order. */
export function routesFor(
  level: LevelKey,
  harnesses: readonly PoolHarness[],
  pools: readonly AccountPool[],
  placement?: Placement,
): PoolRoute[] {
  return harnesses
    .filter((harness) => pools.some((pool) => pool.harness === harness))
    .map((harness) => routeFor(level, harness, pools, placement));
}

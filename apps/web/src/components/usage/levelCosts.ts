/**
 * Costs rolled up the Home tree. Every level's total is what sits right at it
 * plus everything inside it, so going into a scope gives the cost of everything
 * below it, and you can keep going lower. Pure: `useLevelCosts` places the
 * entries and hands in the level chain (`levels.ts`), so the tree, Focus and
 * this rollup agree on where things sit.
 */
import type { LevelKey } from "../levels/levels";
import type { PoolHarness } from "../accounts/accountPoolsModel";

export type CostEntryKind = "thread" | "automation" | "agent";

/** Spend by one thing that sits at a level: a thread, an automation's runs, a level agent's own work. */
export interface CostEntry {
  readonly id: string;
  readonly kind: CostEntryKind;
  readonly label: string;
  /** Where it sits now. */
  readonly level: LevelKey;
  readonly harness: PoolHarness;
  readonly usd: number;
  /** The pool that paid: the nearest on its level's chain. Null when no pool covers it. */
  readonly paidBy: string | null;
}

export interface LevelCost {
  /** This level and everything inside it. */
  readonly totalUsd: number;
  /** Only what sits right at this level. */
  readonly ownUsd: number;
  /** `totalUsd` split by the pool that paid (null: no pool, billed elsewhere). */
  readonly byPool: ReadonlyMap<string | null, number>;
}

type ChainOf = (level: LevelKey) => readonly LevelKey[];

/**
 * Adds each entry to its own level and every level above it. `chainOf` returns
 * the level itself first, then each one above (`levelChain`).
 */
export function rollUpCosts(
  entries: readonly CostEntry[],
  chainOf: ChainOf,
): ReadonlyMap<LevelKey, LevelCost> {
  const costs = new Map<
    LevelKey,
    { totalUsd: number; ownUsd: number; byPool: Map<string | null, number> }
  >();
  for (const entry of entries) {
    chainOf(entry.level).forEach((level, index) => {
      let cost = costs.get(level);
      if (!cost) {
        cost = { totalUsd: 0, ownUsd: 0, byPool: new Map() };
        costs.set(level, cost);
      }
      cost.totalUsd += entry.usd;
      if (index === 0) cost.ownUsd += entry.usd;
      cost.byPool.set(entry.paidBy, (cost.byPool.get(entry.paidBy) ?? 0) + entry.usd);
    });
  }
  return costs;
}

const NO_COST: LevelCost = { totalUsd: 0, ownUsd: 0, byPool: new Map() };

export function costAt(costs: ReadonlyMap<LevelKey, LevelCost>, level: LevelKey): LevelCost {
  return costs.get(level) ?? NO_COST;
}

/** The levels directly inside `parent`, in the order given (tree order). */
export function childLevels<T extends { readonly key: LevelKey }>(
  parent: LevelKey,
  levels: readonly T[],
  chainOf: ChainOf,
): T[] {
  return levels.filter((level) => level.key !== parent && chainOf(level.key)[1] === parent);
}

/** The path from the top down to `level`, for the breadcrumb. */
export function levelPath(level: LevelKey, chainOf: ChainOf): LevelKey[] {
  return chainOf(level).toReversed();
}

import type {
  FolderLevel as PoolLevel,
  FolderResolvedPool as ResolvedPool,
} from "@t3tools/contracts/signalboxFolders";

import type { PoolBinding } from "./ResourceBindings.ts";

/**
 * Which pool a level runs on. Everything runs on its home's chain: the home,
 * then each level above it up to the top. A home uses what is placed at it,
 * and what is placed above it with reach `below`. The nearest pool wins,
 * whole: it supplies every harness. None on the chain means none at all,
 * never a silent fallback.
 *
 * The chain is only `parentOf`: the user's folders build it (`folderTree.ts`),
 * and instructions cascade down the same chain.
 */

export interface PoolTree {
  /** The level directly above `level`; null for the top level. */
  readonly parentOf: (level: PoolLevel) => PoolLevel | null;
  readonly bindings: ReadonlyArray<PoolBinding>;
}

const levelKey = (level: PoolLevel) => {
  switch (level._tag) {
    case "top":
      return "top";
    case "folder":
      return `folder:${level.folderId}`;
  }
};

/** `home` and every level above it, nearest first. A cycle ends where it repeats. */
export const chainOf = (tree: PoolTree, home: PoolLevel): ReadonlyArray<PoolLevel> => {
  const chain: Array<PoolLevel> = [];
  const seen = new Set<string>();
  for (let level: PoolLevel | null = home; level !== null; level = tree.parentOf(level)) {
    const key = levelKey(level);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(level);
  }
  return chain;
};

/** The nearest pool on `home`'s chain, or null when there is none. */
export const resolvePool = (tree: PoolTree, home: PoolLevel): ResolvedPool | null => {
  const byLevel = new Map<string, Array<PoolBinding>>();
  for (const binding of tree.bindings) {
    const key = levelKey(binding.level);
    byLevel.set(key, [...(byLevel.get(key) ?? []), binding]);
  }
  for (const [index, level] of chainOf(tree, home).entries()) {
    // Only the home itself takes a pool that reaches no further than its level.
    const found = byLevel
      .get(levelKey(level))
      ?.find((binding) => index === 0 || binding.reach === "below");
    if (found !== undefined) return { poolId: found.poolId, from: found.level };
  }
  return null;
};

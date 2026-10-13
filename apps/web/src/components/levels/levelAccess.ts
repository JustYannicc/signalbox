/**
 * What an agent can use and whom it has to ask, over anything placed at
 * levels. The direction of access lives in `levels.ts` (`canUseAny`,
 * `askLevelAny`, `nearestOnChain`); this only sorts things by those answers,
 * passing each thing's reach along.
 */
import {
  askLevelAny,
  canUseAny,
  levelChain,
  nearestOnChain,
  type LevelKey,
  type Reach,
} from "./levels";

export interface Leveled {
  readonly levels: readonly LevelKey[];
  /** Absent means `here`: only agents at its levels (and above) can use it. */
  readonly reach?: Reach;
}

type Placement = Parameters<typeof levelChain>[1];

export interface AgentAccess<T> {
  readonly usable: readonly T[];
  /** Out of reach, by the agent to ask, nearest first. */
  readonly asks: readonly { readonly level: LevelKey; readonly things: readonly T[] }[];
}

/** Things placed exactly at `level` (one of their levels). */
export function placedAt<T extends Leveled>(things: readonly T[], level: LevelKey): T[] {
  return things.filter((thing) => thing.levels.includes(level));
}

/**
 * Things `level` can use only because they reach below from a level above it,
 * each with the nearest level it comes from. Things at or below `level` aren't
 * inherited, even when they also sit higher up.
 */
export function inheritedAt<T extends Leveled>(
  things: readonly T[],
  level: LevelKey,
  placement?: Placement,
): { readonly thing: T; readonly from: LevelKey }[] {
  return things.flatMap((thing) => {
    if (thing.reach !== "below") return [];
    if (canUseAny(level, thing.levels, placement, "here")) return [];
    const from = nearestOnChain(level, thing.levels, placement);
    return from === null ? [] : [{ thing, from }];
  });
}

/** Splits things into what `agentLevel` can use and what it has to ask for. Unplaced things are in neither. */
export function agentAccess<T extends Leveled>(
  agentLevel: LevelKey,
  things: readonly T[],
  placement?: Placement,
): AgentAccess<T> {
  const usable: T[] = [];
  const asks = new Map<LevelKey, T[]>();
  for (const thing of things) {
    if (canUseAny(agentLevel, thing.levels, placement, thing.reach)) {
      usable.push(thing);
      continue;
    }
    const ask = askLevelAny(agentLevel, thing.levels, placement, thing.reach);
    if (ask === null) continue;
    asks.set(ask, [...(asks.get(ask) ?? []), thing]);
  }
  const chain = levelChain(agentLevel, placement);
  return {
    usable,
    asks: [...asks.entries()]
      .map(([level, asked]) => ({ level, things: asked }))
      .toSorted((left, right) => chain.indexOf(left.level) - chain.indexOf(right.level)),
  };
}

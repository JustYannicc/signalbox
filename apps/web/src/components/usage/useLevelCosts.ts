/**
 * The cost rollup, live: places each spend entry where Home has it now (your
 * moves win), finds the pool that paid it (nearest on its chain, as model
 * pools route), drops what Focus keeps out of sight, and rolls it up the tree.
 * The Costs page and a level's page in Plugins both read this, so they agree.
 */
import { useMemo } from "react";

import { USABLE_POOLS } from "../accounts/accountPoolsFixtures";
import { routeFor } from "../accounts/poolRouting";
import { levelChain, TOP_LEVEL, type LevelKey } from "../levels/levels";
import { useHomeProjectRefs } from "../levels/useHomeProjectRefs";
import { CURRENT_PERSON_ID } from "../multiplayer/multiplayerFixtures";
import { isLevelInFocus, projectSectionId } from "../sidebar/focus/focusLevels";
import { useFocusedLevel } from "../sidebar/focus/focusStore";
import { resolveTarget, useMappedStore } from "../sidebar/sections/mappedItems";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { LEVEL_COST_FIXTURES, type CostFixture } from "./levelCostFixtures";
import { rollUpCosts, type CostEntry, type LevelCost } from "./levelCosts";

export interface LevelCosts {
  readonly costs: ReadonlyMap<LevelKey, LevelCost>;
  /** Entries in sight, placed. */
  readonly entries: readonly CostEntry[];
  readonly chainOf: (level: LevelKey) => readonly LevelKey[];
  /** Whether a level is in sight under the current Focus. */
  readonly inSight: (level: LevelKey) => boolean;
  /** True when Focus hides some levels' spend. */
  readonly focused: boolean;
}

export function useLevelCosts(): LevelCosts {
  const projects = useHomeProjectRefs();
  const overrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const mappedHomes = useMappedStore((state) => state.homes);
  const focusedLevel = useFocusedLevel();

  return useMemo(() => {
    // Real projects only reach `levels.ts` once the Home tree renders, so place them the way it does.
    const placement = {
      projectSectionOverrides: {
        ...overrides,
        ...Object.fromEntries(
          projects.map((project) => [project.projectKey, projectSectionId(project, overrides)]),
        ),
      },
    };
    const chainOf = (level: LevelKey) => levelChain(level, placement);
    const inSight = (level: LevelKey) => isLevelInFocus(level, focusedLevel, placement);
    const levelOf = (fixture: CostFixture): LevelKey => {
      const moved =
        fixture.kind === "thread"
          ? itemContainers[fixture.id]
          : fixture.kind === "automation"
            ? mappedHomes[`automation:${fixture.id}`]
            : undefined;
      return moved ?? resolveTarget(fixture.home, projects);
    };
    const entries = LEVEL_COST_FIXTURES.map((fixture): CostEntry => {
      const level = levelOf(fixture);
      const route = routeFor(level, fixture.harness, USABLE_POOLS, placement);
      return {
        id: fixture.id,
        kind: fixture.kind,
        label: fixture.label,
        level,
        harness: fixture.harness,
        usd: fixture.usd,
        paidBy:
          route.pools.length > 0
            ? route.pools
                .map((pool) =>
                  pool.ownerId === CURRENT_PERSON_ID ? `Your ${pool.name}` : pool.name,
                )
                .join(" + ")
            : null,
      };
    }).filter((entry) => inSight(entry.level));
    return {
      costs: rollUpCosts(entries, chainOf),
      entries,
      chainOf,
      inSight,
      focused: focusedLevel !== TOP_LEVEL,
    };
  }, [focusedLevel, itemContainers, mappedHomes, overrides, projects]);
}

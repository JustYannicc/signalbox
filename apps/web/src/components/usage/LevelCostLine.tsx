/**
 * One level's spend in a sentence, linking into Usage › Costs at that level.
 * For a level's page in Plugins; same rollup as the Costs page.
 */
import { formatUsd } from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";

import type { LevelKey } from "../levels/levels";
import { LEVEL_COST_WINDOW_LABEL } from "./levelCostFixtures";
import { costAt } from "./levelCosts";
import { useLevelCosts } from "./useLevelCosts";

export function LevelCostLine(props: { level: LevelKey }) {
  const { costs } = useLevelCosts();
  const cost = costAt(costs, props.level);
  return (
    <p className="text-sm text-muted-foreground">
      Spent <span className="text-foreground tabular-nums">{formatUsd(cost.totalUsd)}</span>
      {cost.ownUsd !== cost.totalUsd ? " with everything inside" : ""} ·{" "}
      {LEVEL_COST_WINDOW_LABEL.toLowerCase()} ·{" "}
      <Link to="/costs" search={{ level: props.level }} className="hover:underline">
        See costs
      </Link>
    </p>
  );
}

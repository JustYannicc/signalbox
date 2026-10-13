/**
 * Which pool each Home folder routes through, per harness, and where it comes
 * from ("Northwind Codex pool, inherited from Northwind team" or "its own").
 * Usage › Accounts lists every folder; Plugins › Levels shows one level with
 * `PoolRouteList`. Resolution is `poolRouting.ts`; read it there, not here.
 */
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { levelLabel, type LevelKey } from "../levels/levels";
import type { LevelOption } from "../levels/levelOptions";
import { POOL_HARNESSES, POOL_LABEL, type AccountPool } from "./accountPoolsModel";
import { PoolMark } from "./accountPoolsPrimitives";
import { poolLevels, routesFor, type PoolRoute } from "./poolRouting";

/** Last path segment of a level ("Northwind team"), for "inherited from …". */
function useLevelName(): (key: LevelKey) => string {
  const options = useLevelOptionsContext();
  return useMemo(() => {
    const byKey = new Map(options.map((option) => [option.key, option.name] as const));
    return (key) => byKey.get(key) ?? levelLabel(key);
  }, [options]);
}

function RouteCell(props: { route: PoolRoute; levelName: (key: LevelKey) => string }) {
  const { route } = props;
  const source =
    route.from === null
      ? "Nothing on its path"
      : route.inherited
        ? `Inherited from ${props.levelName(route.from)}`
        : "Its own";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <PoolMark harness={route.harness} className="mt-0.5 size-3.5" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">
          {route.pools.length === 0
            ? `No ${POOL_LABEL[route.harness]} pool`
            : route.pools.map((pool) => pool.name).join(" + ")}
        </span>
        <span className="truncate text-xs text-muted-foreground">{source}</span>
      </div>
    </div>
  );
}

/** One level's routes, stacked; for a level's page in Plugins. */
export function PoolRouteList(props: { level: LevelKey; pools: readonly AccountPool[] }) {
  const levelName = useLevelName();
  const routes = routesFor(props.level, POOL_HARNESSES, props.pools);
  return (
    <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4">
      {routes.map((route) => (
        <RouteCell key={route.harness} route={route} levelName={levelName} />
      ))}
    </div>
  );
}

/** Folders worth a row: the top, every section, team projects, and projects with a pool of their own. */
function routedLevels(options: readonly LevelOption[], pools: readonly AccountPool[]) {
  const own = new Set(pools.flatMap(poolLevels));
  return options.filter(
    (option) =>
      option.kind !== "project" || option.key.startsWith("team-project:") || own.has(option.key),
  );
}

/** Every folder's routes, for Usage › Accounts. `pools` are the ones you can use right now. */
export function PoolRoutes(props: { pools: readonly AccountPool[] }) {
  const options = useLevelOptionsContext();
  const levelName = useLevelName();
  const levels = routedLevels(options, props.pools);
  return (
    <section aria-labelledby="pool-routes" className="flex flex-col gap-2">
      <h2 id="pool-routes" className="text-sm font-medium text-foreground">
        Which pool each folder uses
      </h2>
      <p className="text-xs text-muted-foreground">
        A pool covers every folder inside the one it sits in. The nearest wins: a project's own
        pool, else its section's, and so on up.
      </p>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {levels.map((level) => (
          <li
            key={level.key}
            className="flex flex-col gap-2 py-2.5 pr-3 md:flex-row md:items-center md:gap-4"
            // Indent by depth so the list reads like the Home tree.
            style={{ paddingLeft: `${0.75 + level.depth}rem` }}
          >
            <Link
              to="/plugins"
              search={{ section: "levels", group: level.key }}
              className="min-w-0 truncate text-sm font-medium text-foreground hover:underline md:w-44 md:shrink-0"
            >
              {level.name}
            </Link>
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
              {routesFor(level.key, POOL_HARNESSES, props.pools).map((route) => (
                <RouteCell key={route.harness} route={route} levelName={levelName} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

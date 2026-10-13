/**
 * "Who does this agent represent?": a header button on section and project
 * agent pages. It opens what the agent can use at its own level and below,
 * what reaches down to it from a level above (and from where), which model
 * pools it routes through (nearest wins), whom it has to ask for everything
 * else and what asking gets (a loan for the task, or the answer without the
 * thing), then its recent asks. Which is which comes from `levels.ts` and
 * `accounts/poolRouting.ts`, never from here. Connections, skills, and
 * plugins come from Plugins; pass automations and places mapped into Home
 * folders as `mappedThings`.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, KeyRoundIcon } from "lucide-react";

import { USABLE_POOLS } from "../accounts/accountPoolsFixtures";
import { POOL_HARNESSES, POOL_LABEL } from "../accounts/accountPoolsModel";
import { PoolMark } from "../accounts/accountPoolsPrimitives";
import { routesFor } from "../accounts/poolRouting";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { agentAccess, inheritedAt } from "./levelAccess";
import type { LevelKey } from "./levels";
import { RecentAsks } from "./RecentAsks";
import { countThings, useLeveledThings, type LeveledThing, type ThingKind } from "./leveledThings";
import {
  LevelOptionsProvider,
  useLevelAgentName,
  useLevelLabel,
  useLevelOptionsContext,
} from "./LevelOptionsProvider";

const KIND_ORDER: readonly ThingKind[] = [
  "connections",
  "apis",
  "skills",
  "automations",
  "places",
  "plugins",
];

const VISIBLE_NAMES = 4;

function byKind(things: readonly LeveledThing[]) {
  return KIND_ORDER.flatMap((kind) => {
    const ofKind = things.filter((thing) => thing.kind === kind);
    return ofKind.length > 0 ? [{ kind, things: ofKind }] : [];
  });
}

function Heading(props: { children: string }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{props.children}</h3>;
}

function KindCounts(props: { things: readonly LeveledThing[] }) {
  const groups = byKind(props.things);
  if (groups.length === 0) return <p className="text-muted-foreground">Nothing yet.</p>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {groups.map((group) => (
        <div key={group.kind} className="contents">
          <dt className="text-foreground tabular-nums">
            {countThings(group.things.length, group.kind)}
          </dt>
          <dd className="truncate text-muted-foreground">
            {group.things
              .slice(0, VISIBLE_NAMES)
              .map((thing) => thing.name)
              .join(", ")}
            {group.things.length > VISIBLE_NAMES ? ", …" : ""}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ModelRoutes(props: { level: LevelKey }) {
  const label = useLevelLabel();
  const routes = routesFor(props.level, POOL_HARNESSES, USABLE_POOLS);
  if (routes.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Models</Heading>
      <ul className="flex flex-col gap-1">
        {routes.map((route) => (
          <li key={route.harness} className="flex min-w-0 items-center gap-2">
            <PoolMark harness={route.harness} className="size-3.5" />
            <span className="truncate text-foreground">
              {route.pools.length === 0
                ? `No ${POOL_LABEL[route.harness]} pool`
                : route.pools.map((pool) => pool.name).join(" + ")}
            </span>
            <span className="ms-auto shrink-0 text-xs text-muted-foreground">
              {route.from === null
                ? "nothing on its path"
                : route.inherited
                  ? `from ${label(route.from)}`
                  : "its own"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccessBody(props: { level: LevelKey | null; mappedThings: readonly LeveledThing[] }) {
  const options = useLevelOptionsContext();
  const agentName = useLevelAgentName();
  const label = useLevelLabel();
  const plugins = useLeveledThings();
  const level = options.find((option) => option.key === props.level);
  if (!level) {
    return <p className="text-sm text-muted-foreground">This agent isn't placed in Home.</p>;
  }
  // Pools resolve by nearest level (Models below), so they're never asked for.
  const things = [...plugins, ...props.mappedThings].filter((thing) => thing.kind !== "models");
  const access = agentAccess(level.key, things);
  const inherited = inheritedAt(things, level.key);
  const inheritedKeys = new Set(inherited.map(({ thing }) => thing.key));
  const own = access.usable.filter((thing) => !inheritedKeys.has(thing.key));

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Represents <span className="text-foreground">{level.label}</span>. It uses what sits here
        and in the folders inside; nothing above unless it reaches down.
      </p>
      <section className="flex flex-col gap-1.5">
        <Heading>Can use here</Heading>
        <KindCounts things={own} />
      </section>
      {inherited.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <Heading>Reaches down from above</Heading>
          <ul className="flex flex-col gap-1">
            {inherited.map(({ thing, from }) => (
              <li key={thing.key} className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-foreground">{thing.name}</span>
                <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                  from {label(from)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ModelRoutes level={level.key} />
      {access.asks.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <Heading>Has to ask</Heading>
          <ul className="flex flex-col gap-2">
            {access.asks.map((ask) => (
              <li key={ask.level} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-foreground">{agentName(ask.level)}</span>
                  <span className="truncate text-muted-foreground">
                    for{" "}
                    {byKind(ask.things)
                      .map((group) => countThings(group.things.length, group.kind))
                      .join(", ")}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground text-pretty">
                  If that's fine, it lends access for this task only, until the task ends. If not,
                  it does the work itself and hands back only what's needed.
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <RecentAsks level={level.key} />
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        render={<Link to="/plugins" search={{ section: "levels", group: level.key }} />}
      >
        Change in Plugins
        <ArrowUpRightIcon aria-hidden />
      </Button>
    </div>
  );
}

export function AgentAccess(props: {
  /** The level the agent represents; null when it isn't placed in Home. */
  level: LevelKey | null;
  /**
   * Automations and places mapped into Home folders, as leveled things with
   * kind "automations" | "places" and `levels` = their mapped container keys.
   * Empty until the Home tree's mapped index is passed in.
   */
  mappedThings?: readonly LeveledThing[];
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Access" />}
            />
          }
        >
          <KeyRoundIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Access</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg">
        <LevelOptionsProvider>
          <AccessBody level={props.level} mappedThings={props.mappedThings ?? []} />
        </LevelOptionsProvider>
      </PopoverPopup>
    </Popover>
  );
}

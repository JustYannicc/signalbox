/**
 * "Who does this agent represent?": a header button on section and project
 * agent pages. It opens what the agent can use (by type), whom it has to ask
 * for everything else and what asking gets (a loan for the task, or the
 * answer without the thing), then its recent asks. Which is which comes from
 * `levels.ts`, never from here. Connections, skills, and plugins come from
 * Plugins; pass automations and places mapped into Home folders as
 * `mappedThings`.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, KeyRoundIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { agentAccess } from "./levelAccess";
import { RecentAsks } from "./RecentAsks";
import { countThings, useLeveledThings, type LeveledThing, type ThingKind } from "./leveledThings";
import {
  LevelOptionsProvider,
  useLevelAgentName,
  useLevelOptionsContext,
} from "./LevelOptionsProvider";

const KIND_ORDER: readonly ThingKind[] = [
  "connections",
  "apis",
  "skills",
  "automations",
  "places",
  "plugins",
  "models",
];

const VISIBLE_NAMES = 4;

function byKind(things: readonly LeveledThing[]) {
  return KIND_ORDER.flatMap((kind) => {
    const ofKind = things.filter((thing) => thing.kind === kind);
    return ofKind.length > 0 ? [{ kind, things: ofKind }] : [];
  });
}

function AccessBody(props: { agentId: string; mappedThings: readonly LeveledThing[] }) {
  const options = useLevelOptionsContext();
  const agentName = useLevelAgentName();
  const plugins = useLeveledThings();
  const level = options.find((option) => option.agentId === props.agentId);
  if (!level) {
    return <p className="text-sm text-muted-foreground">This agent isn't placed in Home.</p>;
  }
  const access = agentAccess(level.key, [...plugins, ...props.mappedThings]);
  const usable = byKind(access.usable);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Represents <span className="text-foreground">{level.label}</span>
      </p>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Can use</h3>
        {usable.length === 0 ? (
          <p className="text-muted-foreground">Nothing yet.</p>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {usable.map((group) => (
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
        )}
      </section>
      {access.asks.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Has to ask</h3>
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
  agentId: string;
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
          <AccessBody agentId={props.agentId} mappedThings={props.mappedThings ?? []} />
        </LevelOptionsProvider>
      </PopoverPopup>
    </Popover>
  );
}
